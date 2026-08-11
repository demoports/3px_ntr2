import * as THREE from 'three';
import { DemoEffect } from '../core/DemoEffect.js';
import { renderWithoutClearing } from '../engine/RenderUtils.js';

function configureBlendMode( material, blendMode ) {

    if ( blendMode === 'additive' ) {

        // src * srcAlpha + dst * 1
        material.blending = THREE.CustomBlending;
        material.blendSrc = THREE.SrcAlphaFactor;
        material.blendDst = THREE.OneFactor;
        material.blendEquation = THREE.AddEquation;

    } else {

        material.blending = THREE.NormalBlending;

    }

    material.needsUpdate = true;

}

/**
 * FXStill - Static image overlay effect with animation and fading
 * Renders images at their actual pixel size at specified screen positions
 */
export class FXStill extends DemoEffect {

    constructor( name, dataArchive, textureLoader ) {

        super( name );

        this.dataArchive = dataArchive;
        this.textureLoader = textureLoader;

        this.isLoaded = false;
        this.images = []; // Texture objects
        this.imageSizes = []; // { width, height } for each image
        this.positions = []; // [x, y] pairs in pixel coordinates
        this.frameTime = 1.0;
        this.blendMode = 'normal'; // 'normal' or 'additive'

        this.isFadingIn = false;
        this.isFadingOut = false;
        this.fadeStartTime = 0;
        this.fadeDuration = 0;

        // Rendering state
        this.currentAlpha = 1.0;
        this.currentFrame = 0;
        this.scene = new THREE.Scene();

        // Orthographic camera in pixel coordinates
        // In screen coords: (0,0) is top-left, Y increases downward
        // In Three.js: Y increases upward, so we use top=480, bottom=0
        // This means: world Y=480 maps to screen top, world Y=0 maps to screen bottom
        this.camera = new THREE.OrthographicCamera( 0, 640, 480, 0, 0, 1 );
        this.quads = [];

    }

    shutdown() {

        this.clearImages();

        super.shutdown();
        return 0;

    }

    stop() {

        this.isFadingIn = false;
        this.isFadingOut = false;
        this.currentAlpha = 1;
        this.currentFrame = 0;
        super.stop();
        return 0;

    }

    update( time ) {

        if ( ! this.isActive || ! this.isLoaded ) {

            return this.isActive;

        }

        const animTime = time - this.startTime;

        this.currentFrame = this.images.length > 0
            ? Math.floor( animTime / this.frameTime ) % this.images.length
            : 0;

        // Handle fading
        this.currentAlpha = 1.0;

        if ( this.isFadingIn || this.isFadingOut ) {

            let fade = 1.0;

            if ( this.fadeDuration > 0 ) {

                fade = THREE.MathUtils.clamp(
                    ( time - this.fadeStartTime ) / this.fadeDuration,
                    0,
                    1
                );

            }

            // FADEIN: image fades in (appears), alpha 0→1
            // FADEOUT: image fades out (disappears), alpha 1→0
            this.currentAlpha = this.isFadingIn ? fade : ( 1.0 - fade );

        }

        // Update visibility of quads
        for ( let i = 0; i < this.quads.length; i ++ ) {

            const quad = this.quads[ i ];

            if ( ! quad ) continue;

            quad.visible = i === this.currentFrame && Boolean( this.images[ i ] );
            if ( quad.visible ) quad.material.opacity = this.currentAlpha;

        }

        return this.isActive;

    }

    render( renderer ) {

        if ( ! this.isLoaded || this.currentAlpha <= 0 ) return;

        // Check if current frame has a valid image
        if ( ! this.images[ this.currentFrame ] ) return;

        renderWithoutClearing( renderer, this.scene, this.camera );

    }

    handleCommand( time, cmd, args ) {

        switch ( cmd ) {

            case 'LOAD':
                return this.loadImages( args );

            case 'POSITION':
                return this.setPosition( parseInt( args[ 0 ] ), parseFloat( args[ 1 ] ), parseFloat( args[ 2 ] ) );

            case 'POSITIONALL':
                return this.setPositionAll( parseFloat( args[ 0 ] ), parseFloat( args[ 1 ] ) );

            case 'BLEND':
                this.blendMode = args[ 0 ]?.toUpperCase() === 'ADDITIVE' ? 'additive' : 'normal';
                this.updateBlendMode();
                return 0;

            case 'FADEIN':
                this.fadeDuration = parseFloat( args[ 0 ] ) || 0;
                this.fadeStartTime = time;
                this.isFadingIn = true;
                this.isFadingOut = false;
                return 0;

            case 'FADEOUT':
                this.fadeDuration = parseFloat( args[ 0 ] ) || 0;
                this.fadeStartTime = time;
                this.isFadingOut = true;
                this.isFadingIn = false;
                return 0;

            case 'LAYER':
                this.setLayer( parseInt( args[ 0 ] ) || 0 );
                return 0;

            default:
                return super.handleCommand( time, cmd, args );

        }

    }

    /**
     * Load images from command arguments
     * Format: LOAD <num_images> <frame_time> <file1> [file2] ...
     */
    async loadImages( args ) {

        if ( args.length < 3 ) return - 1;

        this.clearImages();

        const numImages = parseInt( args[ 0 ] );
        this.frameTime = parseFloat( args[ 1 ] );

        this.images = new Array( numImages ).fill( null );
        this.imageSizes = new Array( numImages ).fill( null );
        this.positions = Array.from( { length: numImages }, () => ( { x: 0, y: 0 } ) );
        this.quads = new Array( numImages ).fill( null );

        // Load each image
        for ( let i = 0; i < numImages; i ++ ) {

            const filename = args[ 2 + i ];

            if ( ! filename || filename === '_' ) {

                this.images[ i ] = null;
                this.imageSizes[ i ] = { width: 0, height: 0 };
                continue;

            }

            const baseName = filename.toLowerCase().replace( /\..+$/, '' );
            const pathJpg = `data/images/${baseName}.jpg`;
            const pathRgb = `data/images/${baseName}@rgb.jpg`;
            const pathAlpha = `data/images/${baseName}@alpha.jpg`;

            try {

                let texture = null;
                let alphaTexture = null;

                // Try @rgb + @alpha pair first
                const rgbBuffer = await this.dataArchive.getFile( pathRgb );

                if ( rgbBuffer ) {

                    const alphaBuffer = await this.dataArchive.getFile( pathAlpha );

                    if ( alphaBuffer ) {

                        // Load RGB and Alpha as separate textures
                        texture = await this.textureLoader.loadFromBuffer( rgbBuffer, pathRgb );
                        alphaTexture = await this.textureLoader.loadFromBuffer( alphaBuffer, pathAlpha );

                    } else {

                        texture = await this.textureLoader.loadFromBuffer( rgbBuffer, pathRgb );

                    }

                } else {

                    // Try plain jpg
                    const buffer = await this.dataArchive.getFile( pathJpg );

                    if ( buffer ) {

                        texture = await this.textureLoader.loadFromBuffer( buffer, pathJpg );

                    }

                }

                if ( texture ) {

                    this.configureTexture( texture );

                    if ( alphaTexture ) {

                        this.configureTexture( alphaTexture );

                    }

                    this.images[ i ] = texture;

                    const { width, height } = texture.image;
                    this.imageSizes[ i ] = { width, height };

                    // Create quad with proper size
                    this.createQuad( i, texture, width, height, alphaTexture );

                } else {

                    throw new Error( `Image not found: ${filename}` );

                }

            } catch ( e ) {

                this.clearImages();
                throw new Error( `${this.name}: Failed to load "${filename}"`, { cause: e } );

            }

        }

        this.isLoaded = true;
        return 0;

    }

    configureTexture( texture ) {

        // ScreenManager used linear sampling without mipmaps for 2D stills.
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;

    }

    clearImages() {

        for ( const quad of this.quads ) {

            if ( ! quad ) continue;
            this.scene.remove( quad );
            quad.geometry.dispose();
            // Textures are shared through TextureLoader's cache and are
            // disposed there, not by individual still effects.
            quad.material.dispose();

        }

        this.quads = [];
        this.images = [];
        this.imageSizes = [];
        this.positions = [];
        this.isLoaded = false;

    }

    /**
     * Create a quad for displaying an image at its actual pixel size
     */
    createQuad( index, texture, width, height, alphaTexture = null ) {

        const geometry = new THREE.PlaneGeometry( width, height );

        const material = new THREE.MeshBasicMaterial( {
            map: texture,
            alphaMap: alphaTexture,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide
        } );

        const quad = new THREE.Mesh( geometry, material );
        quad.visible = false;
        quad.frustumCulled = false;

        this.quads[ index ] = quad;
        this.scene.add( quad );

        this.updateQuadPosition( index );
        configureBlendMode( material, this.blendMode );

    }

    /**
     * Update quad position and geometry when position changes
     */
    updateQuadPosition( index ) {

        const quad = this.quads[ index ];
        const size = this.imageSizes[ index ];
        const pos = this.positions[ index ];

        if ( quad && size ) {

            const worldX = pos.x + size.width / 2;
            const worldY = 480 - pos.y - size.height / 2;
            quad.position.set( worldX, worldY, 0 );

        }

    }

    /**
     * Set position for a specific frame (in pixel coordinates)
     */
    setPosition( frame, x, y ) {

        if ( frame < 0 || frame >= this.images.length ) return - 1;

        this.positions[ frame ] = { x, y };
        this.updateQuadPosition( frame );

        return 0;

    }

    /**
     * Set position for all frames (in pixel coordinates)
     */
    setPositionAll( x, y ) {

        for ( let i = 0; i < this.images.length; i ++ ) {

            this.positions[ i ] = { x, y };
            this.updateQuadPosition( i );

        }

        return 0;

    }

    /**
     * Update blend mode for all quads
     */
    updateBlendMode() {

        for ( const quad of this.quads ) {

            if ( quad ) configureBlendMode( quad.material, this.blendMode );

        }

    }

}
