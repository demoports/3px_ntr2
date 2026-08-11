import * as THREE from 'three';
import { DemoEffect } from '../core/DemoEffect.js';
import { disposeSceneGeometries, renderWithoutClearing } from '../engine/RenderUtils.js';

const FULLSCREEN_VERTEX_SHADER = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
`;

function createRenderTarget( width, height, depthBuffer = false ) {

    return new THREE.WebGLRenderTarget( width, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        depthBuffer,
        stencilBuffer: false
    } );

}

/**
 * FXFilterEffect - FILTROEFECTO post-processing effects
 * Implements temporal motion blur (frame accumulation)
 */
export class FXFilterEffect extends DemoEffect {

    constructor( name ) {

        super( name );

        // Motion blur (temporal/accumulation blur)
        this.motionBlurEnabled = false;
        this.motionBlurFadeIn = false;
        this.motionBlurStartTime = 0;
        this.motionBlurDuration = 0;
        this.motionBlurFactor = 0.1; // Target alpha (low = strong trails)
        this.motionBlurStartLayer = 0;
        this.motionBlurEndLayer = 0;

        // Layer crossfade
        this.crossfadeEnabled = false;
        this.crossfadeStartValue = 0;
        this.crossfadeEndValue = 1;
        this.crossfadeStartTime = 0;
        this.crossfadeDuration = 0;
        this.crossfadeStartLayer = 0;
        this.crossfadeEndLayer = 0;
        this.crossfadeRenderTarget = null;

        // Render targets for accumulation
        this.accumulationRenderTarget = null;
        this.tempRenderTarget = null;

        // Blend material for accumulation
        this.blendMaterial = null;
        this.blendScene = new THREE.Scene();
        this.blendCamera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

        // Copy material for displaying result
        this.copyMaterial = null;
        this.copyScene = new THREE.Scene();
        this.copyCamera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );
        this.crossfadeMaterial = null;
        this.crossfadeScene = new THREE.Scene();

        // Track if accumulation buffer has been initialized
        this.accumulationInitialized = false;

        this.setupMaterials();

    }

    setupMaterials() {

        const blendFragmentShader = `
            uniform sampler2D tDiffuse;
            uniform float uAlpha;
            varying vec2 vUv;

            void main() {
                vec4 color = texture2D( tDiffuse, vUv );
                gl_FragColor = vec4( color.rgb, uAlpha );
            }
        `;

        this.blendMaterial = new THREE.ShaderMaterial( {
            uniforms: {
                tDiffuse: { value: null },
                uAlpha: { value: 1.0 }
            },
            vertexShader: FULLSCREEN_VERTEX_SHADER,
            fragmentShader: blendFragmentShader,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            // Standard alpha blending: SRCALPHA, INVSRCALPHA
            blending: THREE.CustomBlending,
            blendSrc: THREE.SrcAlphaFactor,
            blendDst: THREE.OneMinusSrcAlphaFactor,
            blendEquation: THREE.AddEquation
        } );

        const geometry = new THREE.PlaneGeometry( 2, 2 );
        this.blendScene.add( new THREE.Mesh( geometry, this.blendMaterial ) );

        // Copy material: simple texture copy (no blending - direct overwrite)
        this.copyMaterial = new THREE.MeshBasicMaterial( {
            depthTest: false,
            depthWrite: false,
            blending: THREE.NoBlending
        } );

        this.copyScene.add( new THREE.Mesh( geometry.clone(), this.copyMaterial ) );

        this.crossfadeMaterial = new THREE.MeshBasicMaterial( {
            transparent: true,
            depthTest: false,
            depthWrite: false
        } );
        this.crossfadeScene.add( new THREE.Mesh( geometry.clone(), this.crossfadeMaterial ) );

    }

    ensureRenderTargets( width, height ) {

        const needsResize = ! this.accumulationRenderTarget ||
            this.accumulationRenderTarget.width !== width ||
            this.accumulationRenderTarget.height !== height;

        if ( needsResize ) {

            this.disposeRenderTarget( 'accumulationRenderTarget' );
            this.disposeRenderTarget( 'tempRenderTarget' );

            this.accumulationRenderTarget = createRenderTarget( width, height );
            this.tempRenderTarget = createRenderTarget( width, height );

            // Reset initialization flag when targets are recreated
            this.accumulationInitialized = false;

        }

        if ( ! this.crossfadeRenderTarget ||
            this.crossfadeRenderTarget.width !== width ||
            this.crossfadeRenderTarget.height !== height ) {

            this.disposeRenderTarget( 'crossfadeRenderTarget' );
            this.crossfadeRenderTarget = createRenderTarget( width, height, true );

        }

    }

    disposeRenderTarget( property ) {

        this[ property ]?.dispose();
        this[ property ] = null;

    }

    shutdown() {

        this.disposeRenderTarget( 'accumulationRenderTarget' );
        this.disposeRenderTarget( 'tempRenderTarget' );
        this.disposeRenderTarget( 'crossfadeRenderTarget' );

        disposeSceneGeometries( [ this.blendScene, this.copyScene, this.crossfadeScene ] );
        this.blendMaterial.dispose();
        this.copyMaterial.dispose();
        this.crossfadeMaterial.dispose();

        super.shutdown();
        return 0;

    }

    stop() {

        this.motionBlurEnabled = false;
        this.crossfadeEnabled = false;
        // DemoApp.stop() is the replay boundary, so discard history here. Native
        // command changes and MOTIONBLUROFF deliberately leave it intact below.
        this.accumulationInitialized = false;
        super.stop();
        return 0;

    }

    update( time ) {

        if ( ! this.isActive ) return this.isActive;

        // Check if motion blur fade has completed
        // Matches C++ logic: disable when slider done AND it's FADEOUT
        if ( this.motionBlurEnabled && ! this.motionBlurFadeIn ) {

            const elapsed = time - this.motionBlurStartTime;
            const sliderDone = this.motionBlurDuration <= 0 || elapsed >= this.motionBlurDuration;

            if ( sliderDone ) {

                this.motionBlurEnabled = false;

            }

        }

        return this.isActive;

    }

    /**
     * Calculate the current blend alpha based on fade state
     */
    getMotionBlurAlpha( time ) {

        if ( ! this.motionBlurEnabled ) return 1.0;

        const elapsed = time - this.motionBlurStartTime;
        const progress = this.motionBlurDuration > 0
            ? Math.min( 1.0, elapsed / this.motionBlurDuration )
            : 1.0;

        let alpha;

        if ( this.motionBlurFadeIn ) {

            // FADEIN: 1.0 -> blurFactor (trails get stronger)
            alpha = 1.0 + progress * ( this.motionBlurFactor - 1.0 );

        } else {

            // FADEOUT: blurFactor -> 1.0 (trails fade away)
            alpha = this.motionBlurFactor + progress * ( 1.0 - this.motionBlurFactor );

        }

        return alpha;

    }

    /**
     * Check if motion blur is active
     */
    isMotionBlurActive() {

        return this.motionBlurEnabled;

    }

    /**
     * Process the captured frame and render with motion blur
     */
    processAndRender( renderer, time, outputTarget = null ) {

        if ( ! this.motionBlurEnabled ) return;

        const alpha = this.getMotionBlurAlpha( time );

        // Blend captured frame onto accumulation buffer
        this.blendMaterial.uniforms.tDiffuse.value = this.tempRenderTarget.texture;
        this.blendMaterial.uniforms.uAlpha.value = alpha;

        renderer.setRenderTarget( this.accumulationRenderTarget );

        // Clear accumulation buffer on first frame (matches C++ behavior)
        if ( ! this.accumulationInitialized ) {

            renderer.clear();
            this.accumulationInitialized = true;

        }

        renderWithoutClearing( renderer, this.blendScene, this.blendCamera );

        // Draw accumulated result to screen (no blending - direct copy)
        renderer.setRenderTarget( outputTarget );
        this.copyMaterial.map = this.accumulationRenderTarget.texture;
        renderer.render( this.copyScene, this.copyCamera );

    }

    captureTexture( renderer, sourceTexture, width, height ) {

        this.ensureRenderTargets( width, height );
        this.copyMaterial.map = sourceTexture;
        renderer.setRenderTarget( this.tempRenderTarget );
        renderer.clear();
        renderer.render( this.copyScene, this.copyCamera );

    }

    getCrossfadeRenderTarget( width, height ) {

        this.ensureRenderTargets( width, height );
        return this.crossfadeRenderTarget;

    }

    isCrossfadeActive() {

        return this.crossfadeEnabled;

    }

    getCrossfadeAlpha( time ) {

        const progress = this.crossfadeDuration > 0
            ? Math.min( 1, Math.max( 0, ( time - this.crossfadeStartTime ) / this.crossfadeDuration ) )
            : 1;

        return this.crossfadeStartValue +
            ( this.crossfadeEndValue - this.crossfadeStartValue ) * progress;

    }

    compositeCrossfade( renderer, outputTarget, time ) {

        if ( ! this.crossfadeEnabled || ! this.crossfadeRenderTarget ) return;
        this.crossfadeMaterial.map = this.crossfadeRenderTarget.texture;
        this.crossfadeMaterial.opacity = this.getCrossfadeAlpha( time );
        renderer.setRenderTarget( outputTarget );
        renderWithoutClearing( renderer, this.crossfadeScene, this.copyCamera );

    }

    handleCommand( time, cmd, args ) {

        switch ( cmd ) {

            case 'MOTIONBLUR': {

                const fadeType = args[ 0 ]?.toUpperCase();
                this.motionBlurFadeIn = fadeType === 'FADEIN';
                this.motionBlurDuration = parseFloat( args[ 1 ] ) || 0;
                const blurFactor = parseFloat( args[ 2 ] );
                this.motionBlurFactor = Number.isFinite( blurFactor ) ? blurFactor : 0.1;
                this.motionBlurStartLayer = parseInt( args[ 3 ] ) || 0;
                this.motionBlurEndLayer = parseInt( args[ 4 ] ) || 0;
                this.motionBlurStartTime = time;

                // C++ disables if blurFactor is 0.
                this.motionBlurEnabled = this.motionBlurFactor !== 0;

                return 0;

            }

            case 'MOTIONBLUROFF':
                this.motionBlurEnabled = false;
                return 0;

            case 'CROSSFADE':
                this.crossfadeStartValue = parseFloat( args[ 0 ] ) || 0;
                this.crossfadeEndValue = parseFloat( args[ 1 ] ) || 0;
                this.crossfadeDuration = parseFloat( args[ 2 ] ) || 0;
                this.crossfadeStartLayer = parseInt( args[ 3 ] ) || 0;
                this.crossfadeEndLayer = parseInt( args[ 4 ] ) || 0;
                this.crossfadeStartTime = time;
                this.crossfadeEnabled = true;
                return 0;

            case 'CROSSFADEOFF':
                this.crossfadeEnabled = false;
                return 0;

            default:
                return super.handleCommand( time, cmd, args );

        }

    }

}
