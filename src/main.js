import * as THREE from 'three';
import { DataArchive } from './loaders/DataArchive.js';
import { TextureLoader } from './loaders/TextureLoader.js';
import { DemoPlayer } from './core/DemoPlayer.js';
import { MusicPlayer } from './core/MusicPlayer.js';
import { FXEscena3D } from './effects/FXEscena3D.js';
import { FXStill } from './effects/FXStill.js';
import { FXFilter } from './effects/FXFilter.js';
import { FXFilterEffect } from './effects/FXFilterEffect.js';
import { FXFlare } from './effects/FXFlare.js';
import { shaderNoiseManager } from './engine/ShaderNoiseManager.js';
import { warmupRenderer } from './engine/RendererWarmup.js';

const DEMO_WIDTH = 640;
const DEMO_HEIGHT = 480;
const DEMO_ASPECT = DEMO_WIDTH / DEMO_HEIGHT;
const POST_PROCESS_LAYER = 8;
const MAX_LAYERS = 16;
const KEY_SEEK_OFFSETS = {
    ArrowLeft: - 5,
    ArrowRight: 5
};

function nowSeconds() {

    return performance.now() / 1000;

}

// Match the native priority buckets: shader order first, followed by depth.
function compareRenderItems( a, b ) {

    if ( a.groupOrder !== b.groupOrder ) {

        return a.groupOrder - b.groupOrder;

    }

    if ( a.renderOrder !== b.renderOrder ) {

        return a.renderOrder - b.renderOrder;

    }

    const shaderOrderA = a.material.userData.shaderOrder ?? a.material.id;
    const shaderOrderB = b.material.userData.shaderOrder ?? b.material.id;

    if ( shaderOrderA !== shaderOrderB ) {

        return shaderOrderA - shaderOrderB;

    }

    const depthA = a.object.userData.nativeDepth ?? a.z;
    const depthB = b.object.userData.nativeDepth ?? b.z;

    if ( depthA !== depthB ) {

        return a.renderOrder === 3 ? depthA - depthB : depthB - depthA;

    }

    return a.id - b.id;

}

/**
 * 3PX Demo Player - Three.js Port
 */

export class DemoApp {

    constructor( dataFile ) {

        this.dataFile = dataFile;

        // Three.js components
        this.renderer = null;
        this.defaultScene = new THREE.Scene();
        this.defaultCamera = new THREE.PerspectiveCamera( 75, DEMO_ASPECT, 0.1, 1000 );
        this.contentRenderTarget = null;
        this.renderSize = new THREE.Vector2();

        // Demo components
        this.dataArchive = new DataArchive();
        this.textureLoader = new TextureLoader();
        this.demoPlayer = new DemoPlayer();
        this.musicPlayer = new MusicPlayer();

        // Effects
        this.effects = new Map();
        this.fxFilter = null;
        this.fxFilterEffect = null;

        // State
        this.isRunning = false;
        this.isPaused = false;
        this.lastTime = 0;
        this.animationFrame = null;

        this.onResize = this.onResize.bind( this );
        this.onKeyDown = this.onKeyDown.bind( this );
        this.animate = this.animate.bind( this );
        this.start = this.start.bind( this );
        this.finish = this.finish.bind( this );

        // UI elements
        this.loadingElement = document.getElementById( 'loading' );
        this.progressElement = document.getElementById( 'progress' );
        this.startButton = document.getElementById( 'startButton' );
        this.containerElement = document.getElementById( 'container' );
        this.progressFillElement = document.getElementById( 'progress-fill' );

    }

    async init() {

        this.renderer = new THREE.WebGLRenderer( { antialias: true } );
        this.renderer.setSize( DEMO_WIDTH, DEMO_HEIGHT );
        this.renderer.setPixelRatio( window.devicePixelRatio );
        // Nature v2.0 predates hardware sRGB framebuffers. Its D3D8 pipeline
        // sampled and blended texture bytes directly, so use a deliberate legacy
        // gamma-space pipeline. Linear-light blending makes the additive flowers,
        // flares, still overlays, and motion trails look noticeably different.
        this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
        this.renderer.autoClear = false;

        this.renderer.setOpaqueSort( compareRenderItems );
        this.renderer.setTransparentSort( compareRenderItems );

        this.containerElement.appendChild( this.renderer.domElement );

        // Setup resize handler and trigger initial resize
        window.addEventListener( 'resize', this.onResize );
        this.onResize();

        // Setup keyboard shortcuts
        window.addEventListener( 'keydown', this.onKeyDown );

        // Initialize music player
        this.musicPlayer.init();
        this.musicPlayer.onEnded( this.finish );
        this.musicPlayer.onError( this.finish );

        // Load data archive
        this.updateProgress( 'Loading data archive...' );

        try {

            await this.dataArchive.load( this.dataFile );

        } catch ( e ) {

            console.error( 'Failed to load data archive:', e );
            this.updateProgress( `Failed to load ${this.dataFile}` );
            return;

        }

        // Load and parse script
        this.updateProgress( 'Loading script...' );

        const files = this.dataArchive.getFileList();
        const scriptFile = files.find( file => /(^|\/)script\.txt$/i.test( file ) );
        const scriptText = scriptFile ? await this.dataArchive.getFileAsText( scriptFile ) : null;

        if ( ! scriptText ) {

            console.error( 'Failed to load script.txt' );
            this.updateProgress( 'Failed to load script.txt' );
            return;

        }

        this.demoPlayer.parse( scriptText );

        // Create effects
        this.updateProgress( 'Creating effects...' );
        this.createEffects();

        // Register effects with demo player
        for ( const [ name, effect ] of this.effects ) {

            this.demoPlayer.registerEffect( name, effect );

        }

        // Register music player
        this.demoPlayer.setMusicPlayer( this.musicPlayer );

        // The native demo completed all scene/image loads before starting its
        // timeline. Await the browser equivalents so the opening cannot race
        // texture decoding or 3PX parsing.
        try {

            await this.demoPlayer.preloadResources( ( completed, total ) => {

                this.updateProgress( `Loading resources... ${completed}/${total}` );
                this.updateProgressAmount( 0.75 * completed / total );

            } );

        } catch ( e ) {

            console.error( 'Failed to preload demo resources:', e );
            this.updateProgress( `Failed to load resources: ${e.message}` );
            return;

        }

        // Three.js uploads textures, allocates render targets, and compiles
        // programs lazily. Do that work under the loading screen so changing
        // scenes/effects during playback cannot trigger a first-use GPU stall.
        const drawingSize = this.renderer.getDrawingBufferSize( this.renderSize );
        this.ensureContentRenderTarget( drawingSize.x, drawingSize.y );
        this.fxFilter.ensureBlurRenderTarget( drawingSize.x, drawingSize.y );
        this.fxFilterEffect.ensureRenderTargets( drawingSize.x, drawingSize.y );

        this.updateProgress( 'Preparing graphics...' );

        try {

            await warmupRenderer( {
                renderer: this.renderer,
                effects: this.effects.values(),
                textureLoader: this.textureLoader,
                defaultCamera: this.defaultCamera,
                contentRenderTarget: this.contentRenderTarget,
                onProgress: ( completed, total ) => {

                    this.updateProgress( `Preparing graphics... ${completed}/${total}` );
                    this.updateProgressAmount( 0.75 + 0.2 * completed / total );

                }
            } );

        } catch ( e ) {

            console.error( 'Failed to prepare renderer:', e );
            this.updateProgress( `Failed to prepare renderer: ${e.message}` );
            return;

        }

        // Load music (search for any .mp3 file)
        this.updateProgress( 'Loading music...' );
        this.updateProgressAmount( 0.95 );

        const musicFile = files.find( f => f.toLowerCase().endsWith( '.mp3' ) );

        if ( musicFile ) {

            const musicBuffer = await this.dataArchive.getFile( musicFile );

            if ( musicBuffer ) {

                try {

                    await this.musicPlayer.load( musicBuffer );

                } catch ( e ) {

                    console.error( 'Failed to load music:', e );
                    this.updateProgress( `Failed to load music: ${e.message}` );
                    return;

                }

            }

        } else {

            console.warn( 'Music file not found' );

        }

        // Ready to start
        this.updateProgress( 'Ready!' );
        this.updateProgressAmount( 1 );
        this.loadingElement.classList.add( 'ready' );

        this.startButton.addEventListener( 'click', this.start );

    }

    createEffects() {

        this.fxFilter = this.addEffect( 'FILTER', new FXFilter( 'FILTER' ) );

        this.fxFilterEffect = this.addEffect(
            'FILTROEFECTO', new FXFilterEffect( 'FILTROEFECTO' )
        );

        this.addEffect( 'FLARE_00', new FXFlare( 'FLARE_00' ) );

        // Create 3D scene effects (ESCENA_01 to ESCENA_10)
        for ( let i = 1; i <= 10; i ++ ) {

            const name = `ESCENA_${String( i ).padStart( 2, '0' )}`;
            const effect = new FXEscena3D( name, this.dataArchive, this.textureLoader );
            this.addEffect( name, effect );

        }

        // Create image overlay effects (IMAGE_01 to IMAGE_17)
        for ( let i = 1; i <= 17; i ++ ) {

            const name = `IMAGE_${String( i ).padStart( 2, '0' )}`;
            const effect = new FXStill( name, this.dataArchive, this.textureLoader );
            this.addEffect( name, effect );

        }

    }

    addEffect( name, effect ) {

        effect.init();
        this.effects.set( name, effect );
        return effect;

    }

    start() {

        if ( this.isRunning ) return;

        this.loadingElement.classList.add( 'hidden' );

        // Clear screen to black before starting
        this.renderer.setClearColor( 0x000000 );
        this.renderer.clear();

        // Start FILTER effect (always active for post-processing)
        this.fxFilter.start( 0 );

        // Start demo playback
        this.demoPlayer.start();

        // Note: Music is started by PLAYMUSIC command in the script
        // Don't start it manually here to avoid interfering with script timing

        // Start render loop
        this.isRunning = true;
        this.lastTime = nowSeconds();
        this.animate();

    }

    animate() {

        if ( ! this.isRunning ) return;

        this.animationFrame = requestAnimationFrame( this.animate );

        // Skip updates and rendering when paused
        if ( this.isPaused ) {

            return;

        }

        const currentTime = nowSeconds();
        const deltaTime = currentTime - this.lastTime;
        this.lastTime = currentTime;

        // Get music time for synchronization
        const musicTime = this.musicPlayer.getCurrentTime();

        // Update demo player (processes script commands)
        this.demoPlayer.update( deltaTime, musicTime );

        // Update FILTER separately (handles fade, etc.)
        this.fxFilter.update( musicTime, deltaTime );

        // Render the demo
        this.render( musicTime );

    }

    togglePause() {

        if ( this.isPaused ) {

            this.isPaused = false;
            this.musicPlayer.resume();
            this.lastTime = nowSeconds();

        } else {

            this.isPaused = true;
            this.musicPlayer.pause();

        }

    }

    render( time ) {

        const size = this.renderer.getDrawingBufferSize( this.renderSize );
        this.ensureContentRenderTarget( size.x, size.y );

        // Get background color from filter
        const bgColor = this.fxFilter.getBackgroundColor();
        this.renderer.setClearColor( bgColor );
        this.renderer.setRenderTarget( this.contentRenderTarget );
        this.renderer.clear();

        const drawableEffects = [];

        for ( const effect of this.effects.values() ) {

            if ( effect.isActive && effect !== this.fxFilter && effect !== this.fxFilterEffect ) {

                drawableEffects.push( effect );

            }

        }

        let currentTarget = this.contentRenderTarget;

        // The native runner renders layers 0-7 into FILTER, composites FILTER,
        // then renders layers 8-15 directly. Title and credit overlays rely on
        // this boundary to remain crisp and to sit above full-screen fades.
        for ( let layer = 0; layer < POST_PROCESS_LAYER; layer ++ ) {

            if ( this.fxFilterEffect.isCrossfadeActive() &&
                layer === this.fxFilterEffect.crossfadeStartLayer ) {

                currentTarget = this.fxFilterEffect.getCrossfadeRenderTarget( size.x, size.y );
                this.renderer.setRenderTarget( currentTarget );
                this.renderer.clear();

            }

            this.renderer.setRenderTarget( currentTarget );

            this.renderEffectLayer( drawableEffects, layer );

            if ( this.fxFilterEffect.isMotionBlurActive() &&
                layer === this.fxFilterEffect.motionBlurEndLayer ) {

                this.fxFilterEffect.captureTexture(
                    this.renderer, currentTarget.texture, size.x, size.y
                );
                this.fxFilterEffect.processAndRender( this.renderer, time, currentTarget );

            }

            if ( this.fxFilterEffect.isCrossfadeActive() &&
                layer === this.fxFilterEffect.crossfadeEndLayer ) {

                currentTarget = this.contentRenderTarget;
                this.fxFilterEffect.compositeCrossfade( this.renderer, currentTarget, time );

            }

        }

        // FILTER is the outer render interception stage in the old engine.
        this.fxFilter.processTexture(
            this.renderer, this.contentRenderTarget.texture, null, time, size.x, size.y
        );

        // Render filter effects (fade overlay) - always on top
        if ( this.fxFilter.isActive ) {

            this.fxFilter.render( this.renderer, this.defaultScene, this.defaultCamera );

        }

        this.renderer.setRenderTarget( null );

        for ( let layer = POST_PROCESS_LAYER; layer < MAX_LAYERS; layer ++ ) {

            this.renderEffectLayer( drawableEffects, layer );

        }

    }

    renderEffectLayer( effects, layer ) {

        for ( const effect of effects ) {

            if ( effect.layer === layer ) {

                effect.render( this.renderer, this.defaultScene, this.defaultCamera );

            }

        }

    }

    onKeyDown( event ) {

        if ( ! this.isRunning ) return;

        const seekOffset = KEY_SEEK_OFFSETS[ event.code ];

        if ( seekOffset !== undefined ) {

            event.preventDefault();
            this.seekBy( seekOffset );
            return;

        }

        if ( event.code !== 'Space' ) return;

        event.preventDefault();
        this.togglePause();

    }

    seekBy( offset ) {

        const currentTime = this.musicPlayer.getCurrentTime();
        const duration = this.musicPlayer.duration || Infinity;
        const targetTime = Math.max( 0, Math.min( currentTime + offset, duration ) );

        // Rebuild every scripted state at the destination. This also discards
        // temporal buffers so frames from the old time cannot ghost after a seek.
        shaderNoiseManager.clear();
        this.demoPlayer.seek( targetTime );
        this.fxFilter.start( 0 );
        this.fxFilter.update( targetTime, 0 );
        this.musicPlayer.seek( targetTime );
        this.lastTime = nowSeconds();

        if ( this.isPaused ) this.render( targetTime );

    }

    ensureContentRenderTarget( width, height ) {

        if ( this.contentRenderTarget &&
            this.contentRenderTarget.width === width &&
            this.contentRenderTarget.height === height ) return;

        if ( this.contentRenderTarget ) this.contentRenderTarget.dispose();
        this.contentRenderTarget = new THREE.WebGLRenderTarget( width, height, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            depthBuffer: true
        } );

    }

    onResize() {

        // Always fit the largest 4:3 frame inside the viewport.
        const containerWidth = window.innerWidth;
        const containerHeight = window.innerHeight;
        let width = containerWidth;
        let height = width / DEMO_ASPECT;

        if ( height > containerHeight ) {

            height = containerHeight;
            width = height * DEMO_ASPECT;

        }

        this.renderer.setSize( width, height );

    }

    updateProgress( message ) {

        if ( this.progressElement ) {

            this.progressElement.textContent = message;

        }

    }

    updateProgressAmount( amount ) {

        if ( this.progressFillElement ) {

            this.progressFillElement.style.width = `${Math.round( amount * 100 )}%`;

        }

    }

    stop() {

        if ( this.animationFrame !== null ) {

            cancelAnimationFrame( this.animationFrame );
            this.animationFrame = null;

        }

        this.isRunning = false;
        this.isPaused = false;
        this.demoPlayer.stop();

    }

    finish() {

        if ( ! this.isRunning ) return;

        this.stop();
        this.fxFilter.stop();
        this.fxFilterEffect.stop();
        shaderNoiseManager.clear();

        this.renderer.setRenderTarget( null );
        this.renderer.setClearColor( 0x000000 );
        this.renderer.clear();

        // Resources remain loaded; reveal the ready launcher for another play.
        this.loadingElement.classList.remove( 'hidden' );

    }

    dispose() {

        this.stop();

        // Dispose effects
        for ( const effect of this.effects.values() ) {

            effect.shutdown();

        }

        this.effects.clear();

        window.removeEventListener( 'resize', this.onResize );
        window.removeEventListener( 'keydown', this.onKeyDown );
        this.startButton.removeEventListener( 'click', this.start );
        this.musicPlayer.onEnded( null );
        this.musicPlayer.onError( null );

        // Dispose loaders
        this.textureLoader.dispose();
        this.dataArchive.dispose();
        this.musicPlayer.dispose();

        // Dispose renderer
        if ( this.contentRenderTarget ) this.contentRenderTarget.dispose();
        this.renderer.dispose();

    }

}
