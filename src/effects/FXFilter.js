import * as THREE from 'three';
import { DemoEffect } from '../core/DemoEffect.js';
import { disposeSceneGeometries, renderWithoutClearing } from '../engine/RenderUtils.js';
import { shaderNoiseManager } from '../engine/ShaderNoiseManager.js';

const MAX_BLUR_LOD = 8;
const DISTORTION_GRID_SIZE = 32;

const FULLSCREEN_VERTEX_SHADER = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
`;

function hasFinished( enabled, duration, startTime, time ) {

    return enabled && duration > 0 && time - startTime >= duration;

}

/**
 * FXFilter - Post-processing effects (fade, blur, lens distortion, underwater, wobble)
 */
export class FXFilter extends DemoEffect {

    constructor( name ) {

        super( name );

        // Background color
        this.backgroundColor = new THREE.Color( 0x000000 );
        this.bypassEnabled = false;

        // Fade effect
        this.isFadingIn = false;
        this.isFadingOut = false;
        this.fadeStartTime = 0;
        this.fadeDuration = 0;
        this.fadeColor = new THREE.Color( 0x000000 );
        this.currentFadeAlpha = 0;

        // Underwater effect
        this.underwaterEnabled = false;
        this.underwaterFadeIn = false;
        this.underwaterStartTime = 0;
        this.underwaterDuration = 0;
        this.underwaterFrequency = 1;
        this.underwaterAmplitude = 0.02;

        // Lens distortion
        this.lensEnabled = false;
        this.lensFadeIn = false;
        this.lensStartTime = 0;
        this.lensDuration = 0;
        this.lensStrength = 0;
        this.lensFrequency = 0;

        // Wobble effect
        this.wobbleEnabled = false;
        this.wobbleFadeIn = false;
        this.wobbleStartTime = 0;
        this.wobbleDuration = 0;

        // Blur effect
        this.blurEnabled = false;
        this.blurFadeIn = false;
        this.blurStartTime = 0;
        this.blurDuration = 0;
        this.blurStrength = 0;

        // Horizontal noise
        this.noiseEnabled = false;
        this.noiseStartTime = 0;
        this.noiseDuration = 0;
        this.noiseAmplitude = 0;

        // Full-screen quad for effects
        this.fadeQuad = null;
        this.fadeScene = new THREE.Scene();
        this.fadeCamera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

        // Distortion mesh for LENS/UNDERWATER/WOBBLE effects (32x32 grid)
        this.distortionMesh = null;
        this.distortionScene = new THREE.Scene();
        this.distortionCamera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0.1, 10 );
        this.distortionCamera.position.z = 5;

        // Blur effect resources
        this.blurRenderTarget = null;
        this.blurPyramidRenderTargets = [];
        this.downsampleMaterial = null;
        this.downsampleScene = new THREE.Scene();
        this.blurMaterial = null;
        this.blurScene = new THREE.Scene();
        this.blurCamera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );
        this.outputMaterial = null;
        this.outputScene = new THREE.Scene();
        this.outputCamera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

        this.setupFadeQuad();
        this.setupDistortionMesh();
        this.setupBlurMaterial();

    }

    setupFadeQuad() {

        const geometry = new THREE.PlaneGeometry( 2, 2 );
        const material = new THREE.MeshBasicMaterial( {
            color: 0x000000,
            transparent: true,
            opacity: 0,
            depthTest: false,
            depthWrite: false
        } );

        this.fadeQuad = new THREE.Mesh( geometry, material );
        this.fadeScene.add( this.fadeQuad );

    }

    setupDistortionMesh() {

        const geometry = new THREE.PlaneGeometry(
            2,
            2,
            DISTORTION_GRID_SIZE - 1,
            DISTORTION_GRID_SIZE - 1
        );

        // The D3D projection used z as the homogeneous divisor. Keep the base
        // grid at z=1 so lens/wobble deformation changes the projected shape.
        const positions = geometry.attributes.position.array;
        for ( let i = 2; i < positions.length; i += 3 ) positions[ i ] = 1;

        // Store original positions and UVs for resetting
        this.originalPositions = geometry.attributes.position.array.slice();
        this.originalUVs = geometry.attributes.uv.array.slice();

        // Create material with the scene texture
        const material = new THREE.ShaderMaterial( {
            uniforms: { map: { value: null } },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = vec4( position.xy, 0.0, max( position.z, 0.05 ) );
                }
            `,
            fragmentShader: `
                uniform sampler2D map;
                varying vec2 vUv;
                void main() { gl_FragColor = texture2D( map, vUv ); }
            `,
            depthTest: false,
            depthWrite: false
        } );

        this.distortionMesh = new THREE.Mesh( geometry, material );
        this.distortionScene.add( this.distortionMesh );

    }

    setupBlurMaterial() {

        const downsampleFragmentShader = `
            uniform sampler2D tDiffuse;
            varying vec2 vUv;

            void main() {
                gl_FragColor = texture2D( tDiffuse, vUv );
            }
        `;

        // D3D8 used trilinear mip filtering with an animated LOD bias. Blend
        // adjacent explicit pyramid levels to reproduce that behavior.
        const blurFragmentShader = `
            uniform sampler2D tLowerLevel;
            uniform sampler2D tUpperLevel;
            uniform float levelMix;

            varying vec2 vUv;

            void main() {
                vec4 lower = texture2D( tLowerLevel, vUv );
                vec4 upper = texture2D( tUpperLevel, vUv );
                gl_FragColor = mix( lower, upper, levelMix );
            }
        `;

        this.downsampleMaterial = new THREE.ShaderMaterial( {
            uniforms: {
                tDiffuse: { value: null }
            },
            vertexShader: FULLSCREEN_VERTEX_SHADER,
            fragmentShader: downsampleFragmentShader,
            depthTest: false,
            depthWrite: false,
            blending: THREE.NoBlending
        } );

        this.blurMaterial = new THREE.ShaderMaterial( {
            uniforms: {
                tLowerLevel: { value: null },
                tUpperLevel: { value: null },
                levelMix: { value: 0.0 }
            },
            vertexShader: FULLSCREEN_VERTEX_SHADER,
            fragmentShader: blurFragmentShader,
            depthTest: false,
            depthWrite: false,
            blending: THREE.NoBlending
        } );

        const geometry = new THREE.PlaneGeometry( 2, 2 );
        this.downsampleScene.add( new THREE.Mesh( geometry, this.downsampleMaterial ) );
        this.blurScene.add( new THREE.Mesh( geometry.clone(), this.blurMaterial ) );

        this.outputMaterial = new THREE.MeshBasicMaterial( {
            depthTest: false,
            depthWrite: false,
            blending: THREE.NoBlending
        } );
        this.outputScene.add( new THREE.Mesh( geometry.clone(), this.outputMaterial ) );

    }

    ensureBlurRenderTarget( width, height ) {

        if ( this.blurRenderTarget &&
            this.blurRenderTarget.width === width &&
            this.blurRenderTarget.height === height ) return;

        this.disposeBlurRenderTargets();

        this.blurRenderTarget = this.createBlurRenderTarget( width, height );

        let levelWidth = width;
        let levelHeight = height;

        for ( let level = 1; level <= MAX_BLUR_LOD; level ++ ) {

            if ( levelWidth === 1 && levelHeight === 1 ) break;

            levelWidth = Math.max( 1, Math.floor( levelWidth / 2 ) );
            levelHeight = Math.max( 1, Math.floor( levelHeight / 2 ) );
            this.blurPyramidRenderTargets.push(
                this.createBlurRenderTarget( levelWidth, levelHeight )
            );

        }

    }

    createBlurRenderTarget( width, height ) {

        return new THREE.WebGLRenderTarget( width, height, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            depthBuffer: false,
            stencilBuffer: false,
            generateMipmaps: false
        } );

    }

    disposeBlurRenderTargets() {

        if ( this.blurRenderTarget ) this.blurRenderTarget.dispose();
        this.blurRenderTarget = null;

        for ( const renderTarget of this.blurPyramidRenderTargets ) {

            renderTarget.dispose();

        }

        this.blurPyramidRenderTargets.length = 0;

    }

    shutdown() {

        this.disposeBlurRenderTargets();
        disposeSceneGeometries( [
            this.fadeScene,
            this.distortionScene,
            this.downsampleScene,
            this.blurScene,
            this.outputScene
        ] );
        this.fadeQuad.material.dispose();
        this.distortionMesh.material.dispose();
        this.downsampleMaterial.dispose();
        this.blurMaterial.dispose();
        this.outputMaterial.dispose();
        super.shutdown();
        return 0;

    }

    stop() {

        this.backgroundColor.set( 0x000000 );
        this.bypassEnabled = false;
        this.isFadingIn = false;
        this.isFadingOut = false;
        this.currentFadeAlpha = 0;
        this.underwaterEnabled = false;
        this.lensEnabled = false;
        this.wobbleEnabled = false;
        this.blurEnabled = false;
        this.noiseEnabled = false;
        super.stop();
        return 0;

    }

    update( time ) {

        if ( ! this.isActive ) return this.isActive;

        // Update fade effect
        this.currentFadeAlpha = 0;

        if ( this.isFadingIn || this.isFadingOut ) {

            let fade = 0;

            if ( this.fadeDuration > 0 ) {

                fade = THREE.MathUtils.clamp(
                    ( time - this.fadeStartTime ) / this.fadeDuration,
                    0,
                    1
                );

            }

            if ( fade >= 1.0 ) {

                this.isFadingIn = false;
                this.isFadingOut = false;

            } else {

                // FadeIn: goes from fadeColor to transparent
                // FadeOut: goes from transparent to fadeColor
                this.currentFadeAlpha = this.isFadingIn ? ( 1.0 - fade ) : fade;

            }

        }

        if ( hasFinished( this.underwaterEnabled, this.underwaterDuration, this.underwaterStartTime, time ) ) {

            this.underwaterEnabled = false;

        }

        if ( hasFinished( this.lensEnabled, this.lensDuration, this.lensStartTime, time ) ) {

            this.lensEnabled = false;

        }

        if ( hasFinished( this.blurEnabled, this.blurDuration, this.blurStartTime, time ) ) {

            this.blurEnabled = false;

        }

        if ( hasFinished( this.noiseEnabled, this.noiseDuration, this.noiseStartTime, time ) ) {

            this.noiseEnabled = false;

        }

        if ( hasFinished( this.wobbleEnabled, this.wobbleDuration, this.wobbleStartTime, time ) ) {

            this.wobbleEnabled = false;

        }

        return this.isActive;

    }

    render( renderer ) {

        // Render fade overlay if active
        if ( this.currentFadeAlpha > 0 ) {

            this.fadeQuad.material.color.copy( this.fadeColor );
            this.fadeQuad.material.opacity = this.currentFadeAlpha;

            renderWithoutClearing( renderer, this.fadeScene, this.fadeCamera );

        }

    }

    handleCommand( time, cmd, args ) {

        switch ( cmd ) {

            case 'BACKGROUND':
                this.backgroundColor.setRGB(
                    parseFloat( args[ 0 ] ) || 0,
                    parseFloat( args[ 1 ] ) || 0,
                    parseFloat( args[ 2 ] ) || 0
                );
                return 0;

            case 'FADEIN':
                this.fadeDuration = parseFloat( args[ 0 ] ) || 0;
                this.fadeColor.setRGB(
                    parseFloat( args[ 1 ] ) || 0,
                    parseFloat( args[ 2 ] ) || 0,
                    parseFloat( args[ 3 ] ) || 0
                );
                this.fadeStartTime = time;
                this.isFadingIn = true;
                this.isFadingOut = false;
                return 0;

            case 'FADEOUT':
                this.fadeDuration = parseFloat( args[ 0 ] ) || 0;
                this.fadeColor.setRGB(
                    parseFloat( args[ 1 ] ) || 0,
                    parseFloat( args[ 2 ] ) || 0,
                    parseFloat( args[ 3 ] ) || 0
                );
                this.fadeStartTime = time;
                this.isFadingOut = true;
                this.isFadingIn = false;
                return 0;

            case 'BYPASS':
                this.bypassEnabled = args[ 0 ]?.toUpperCase() === 'ON';
                return 0;

            case 'NOISE':
                this.noiseDuration = parseFloat( args[ 0 ] ) || 0;
                this.noiseAmplitude = parseFloat( args[ 1 ] ) || 0;
                this.noiseStartTime = time;
                this.noiseEnabled = true;
                return 0;

            case 'LENS':
                if ( args[ 0 ]?.toUpperCase() === 'OFF' ) {

                    this.lensEnabled = false;

                } else {

                    this.lensFadeIn = args[ 0 ]?.toUpperCase() === 'FADEIN';
                    this.lensDuration = parseFloat( args[ 1 ] ) || 0;
                    this.lensStrength = parseFloat( args[ 2 ] ) || 0;
                    this.lensFrequency = parseFloat( args[ 3 ] ) || 0;
                    this.lensStartTime = time;
                    this.lensEnabled = true;

                }
                return 0;

            case 'BLUR':
                this.blurFadeIn = args[ 0 ]?.toUpperCase() === 'FADEIN';
                this.blurDuration = parseFloat( args[ 1 ] ) || 0;
                this.blurStrength = parseFloat( args[ 2 ] ) || 0;
                this.blurStartTime = time;
                this.blurEnabled = true;
                return 0;

            case 'WOBBLE':
                if ( args[ 0 ]?.toUpperCase() === 'OFF' ) {

                    this.wobbleEnabled = false;

                } else {

                    this.wobbleFadeIn = args[ 0 ]?.toUpperCase() === 'FADEIN';
                    this.wobbleDuration = parseFloat( args[ 1 ] ) || 0;
                    this.wobbleStartTime = time;
                    this.wobbleEnabled = true;

                }
                return 0;

            case 'UNDERWATER':
                this.underwaterFadeIn = args[ 0 ]?.toUpperCase() === 'FADEIN';
                this.underwaterDuration = parseFloat( args[ 1 ] ) || 0;
                this.underwaterFrequency = parseFloat( args[ 2 ] ) || 1;
                this.underwaterAmplitude = parseFloat( args[ 3 ] ) || 0.02;
                this.underwaterStartTime = time;
                this.underwaterEnabled = true;
                return 0;

            case 'SHADER': {

                const shaderName = args[ 0 ];
                const shaderType = args[ 1 ]?.toUpperCase();

                if ( shaderType === 'NOISE' ) {

                    const fadeIn = args[ 2 ]?.toUpperCase() === 'FADEIN';
                    const duration = parseFloat( args[ 3 ] ) || 0;
                    const ampX = parseFloat( args[ 4 ] ) || 0;
                    const ampY = parseFloat( args[ 5 ] ) || 0;
                    const ampZ = parseFloat( args[ 6 ] ) || 0;
                    const spaceFreq = parseFloat( args[ 7 ] ) || 0;
                    const timeFreq = parseFloat( args[ 8 ] ) || 1;

                    shaderNoiseManager.setNoise(
                        shaderName, fadeIn, duration, time,
                        ampX, ampY, ampZ, spaceFreq, timeFreq
                    );

                }

                return 0;

            }

            default:
                return super.handleCommand( time, cmd, args );

        }

    }

    /**
     * Get the current background color
     */
    getBackgroundColor() {

        return this.backgroundColor;

    }

    /**
     * Check if underwater effect is active and get parameters
     */
    getUnderwaterParams( time ) {

        if ( ! this.underwaterEnabled ) return null;

        const factor = this.underwaterDuration > 0
            ? THREE.MathUtils.clamp(
                ( time - this.underwaterStartTime ) / this.underwaterDuration,
                0,
                1
            )
            : 0;

        const amplitude = this.underwaterFadeIn ?
            this.underwaterAmplitude * ( 1.0 - factor ) :
            this.underwaterAmplitude * factor;

        return {
            frequency: this.underwaterFrequency,
            amplitude,
            time
        };

    }

    /**
     * Check if lens effect is active and get parameters
     */
    getLensParams( time ) {

        if ( ! this.lensEnabled ) return null;

        const factor = this.lensDuration > 0
            ? THREE.MathUtils.clamp(
                ( time - this.lensStartTime ) / this.lensDuration,
                0,
                1
            )
            : 0;

        const strength = this.lensFadeIn
            ? Math.sin( factor * this.lensFrequency ) * this.lensStrength * ( 1 - factor )
            : Math.cos( factor * this.lensFrequency ) * this.lensStrength * factor;

        return {
            strength,
            frequency: this.lensFrequency,
            time
        };

    }

    /**
     * Check if wobble effect is active and get parameters
     */
    getWobbleParams( time ) {

        if ( ! this.wobbleEnabled ) return null;

        const factor = this.wobbleDuration > 0
            ? THREE.MathUtils.clamp(
                ( time - this.wobbleStartTime ) / this.wobbleDuration,
                0,
                1
            )
            : 0;

        const amplitude = this.wobbleFadeIn ?
            ( 1.0 - factor ) :
            factor;

        return {
            amplitude,
            time
        };

    }

    /**
     * Check if blur effect is active and get parameters
     */
    getBlurParams( time ) {

        if ( ! this.blurEnabled ) return null;

        const factor = this.blurDuration > 0
            ? THREE.MathUtils.clamp(
                ( time - this.blurStartTime ) / this.blurDuration,
                0,
                1
            )
            : 0;

        // Match C++ formula: fadeIn means blur goes from full to none
        const amount = this.blurFadeIn
            ? this.blurStrength * ( 1.0 - factor )
            : this.blurStrength * factor;

        return { amount };

    }

    /**
     * Reset distortion mesh to original state
     */
    resetDistortionMesh() {

        const positions = this.distortionMesh.geometry.attributes.position.array;
        const uvs = this.distortionMesh.geometry.attributes.uv.array;

        positions.set( this.originalPositions );
        uvs.set( this.originalUVs );

        this.distortionMesh.geometry.attributes.position.needsUpdate = true;
        this.distortionMesh.geometry.attributes.uv.needsUpdate = true;

    }

    /**
     * Apply LENS distortion - spherical bulge from center
     * Matches C++ RenderLens() which uses UV coords (0-1) converted to (-1 to 1)
     */
    applyLensDistortion( time ) {

        const params = this.getLensParams( time );
        if ( ! params ) return;

        const positions = this.distortionMesh.geometry.attributes.position.array;
        const amplitude = params.strength;

        for ( let j = 0; j < DISTORTION_GRID_SIZE; j ++ ) {

            for ( let i = 0; i < DISTORTION_GRID_SIZE; i ++ ) {

                const posIdx = ( j * DISTORTION_GRID_SIZE + i ) * 3;
                const uvIdx = ( j * DISTORTION_GRID_SIZE + i ) * 2;

                // C++ uses UV coordinates converted to -1 to 1 range
                const u = this.originalUVs[ uvIdx + 0 ];
                const v = this.originalUVs[ uvIdx + 1 ];
                const rx = u * 2.0 - 1.0;
                const ry = v * 2.0 - 1.0;

                // Distance from center squared
                const distSq = rx * rx + ry * ry;

                // Apply spherical bulge inside the unit circle
                // C++ formula: z = 1.0f + (1.0f - (rx*rx+ry*ry)) * fAmplitude
                if ( distSq <= 1.0 ) {

                    positions[ posIdx + 2 ] = 1.0 + ( 1.0 - distSq ) * amplitude;

                } else {

                    positions[ posIdx + 2 ] = 1.0;

                }

            }

        }

        this.distortionMesh.geometry.attributes.position.needsUpdate = true;

    }

    /**
     * Apply UNDERWATER distortion - sinusoidal wave on UVs
     * Matches C++ RenderUnderwater(): u += amplitude * sin(fTime + j*i)
     */
    applyUnderwaterDistortion( time ) {

        const params = this.getUnderwaterParams( time );
        if ( ! params ) return;

        const uvs = this.distortionMesh.geometry.attributes.uv.array;
        const amplitude = params.amplitude;
        const t = time * params.frequency;

        for ( let j = 0; j < DISTORTION_GRID_SIZE; j ++ ) {

            for ( let i = 0; i < DISTORTION_GRID_SIZE; i ++ ) {

                const idx = ( j * DISTORTION_GRID_SIZE + i ) * 2;

                // Reset to original UVs first
                uvs[ idx + 0 ] = this.originalUVs[ idx + 0 ];
                uvs[ idx + 1 ] = this.originalUVs[ idx + 1 ];

                // Wave-based UV distortion (edges stay fixed)
                // C++ formula: u += fAmplitude * sinf(fTime + j*i)
                if ( i > 0 && i < DISTORTION_GRID_SIZE - 1 ) {

                    uvs[ idx + 0 ] += amplitude * Math.sin( t + j * i );

                }

                if ( j > 0 && j < DISTORTION_GRID_SIZE - 1 ) {

                    uvs[ idx + 1 ] += amplitude * Math.cos( t + j * i );

                }

            }

        }

        this.distortionMesh.geometry.attributes.uv.needsUpdate = true;

    }

    /**
     * Apply WOBBLE distortion - combined geometric + UV warping
     * Matches C++ RenderWobble():
     * z = 1.0f - modulate * (0.5 + 0.5*sin(t + i/5)*cos(t + j/5))
     * u = u + 2.5f * sin(t + j*i) * modulate
     * v = v + 2.5f * cos(t + j*i) * modulate
     */
    applyWobbleDistortion( time ) {

        const params = this.getWobbleParams( time );
        if ( ! params ) return;

        const positions = this.distortionMesh.geometry.attributes.position.array;
        const uvs = this.distortionMesh.geometry.attributes.uv.array;
        const t = time;

        const modulate = 0.5 + 0.5 * Math.sin( t );

        for ( let j = 0; j < DISTORTION_GRID_SIZE; j ++ ) {

            for ( let i = 0; i < DISTORTION_GRID_SIZE; i ++ ) {

                const posIdx = ( j * DISTORTION_GRID_SIZE + i ) * 3;
                const uvIdx = ( j * DISTORTION_GRID_SIZE + i ) * 2;

                // Reset UVs to original
                uvs[ uvIdx + 0 ] = this.originalUVs[ uvIdx + 0 ];
                uvs[ uvIdx + 1 ] = this.originalUVs[ uvIdx + 1 ];

                // Z deformation: C++ formula z = 1.0f - modulate * (0.5 + 0.5*sin(t+i/5)*cos(t+j/5))
                const zDeform = modulate * ( 0.5 + 0.5 * Math.sin( t + i / 5.0 ) * Math.cos( t + j / 5.0 ) );
                positions[ posIdx + 2 ] = 1.0 - zDeform;

                // UV warping: C++ uses 2.5f multiplier with j*i pattern (no 0.1 factor)
                uvs[ uvIdx + 0 ] += 2.5 * Math.sin( t + j * i ) * modulate;
                uvs[ uvIdx + 1 ] += 2.5 * Math.cos( t + j * i ) * modulate;

            }

        }

        this.distortionMesh.geometry.attributes.position.needsUpdate = true;
        this.distortionMesh.geometry.attributes.uv.needsUpdate = true;

    }

    /** Build and sample the native-style mip blur pyramid. */
    applyBlur( renderer, sourceTexture, time ) {

        const params = this.getBlurParams( time );
        if ( ! params || params.amount <= 0 ) return sourceTexture;

        // Native formula: fMip = -1 + blurAmount * 9. D3D clamps negative
        // bias to the full-resolution level for this screen-aligned sample.
        const maxLod = this.blurPyramidRenderTargets.length;
        const lod = Math.min( maxLod, Math.max( 0, - 1 + params.amount * 9 ) );

        if ( lod === 0 ) return sourceTexture;

        const levelTextures = [ sourceTexture ];
        let previousTexture = sourceTexture;

        for ( const renderTarget of this.blurPyramidRenderTargets ) {

            this.downsampleMaterial.uniforms.tDiffuse.value = previousTexture;
            renderer.setRenderTarget( renderTarget );
            renderer.render( this.downsampleScene, this.blurCamera );
            previousTexture = renderTarget.texture;
            levelTextures.push( previousTexture );

        }

        const lowerLevel = Math.floor( lod );
        const upperLevel = Math.ceil( lod );

        this.blurMaterial.uniforms.tLowerLevel.value = levelTextures[ lowerLevel ];
        this.blurMaterial.uniforms.tUpperLevel.value = levelTextures[ upperLevel ];
        this.blurMaterial.uniforms.levelMix.value = lod - lowerLevel;

        renderer.setRenderTarget( this.blurRenderTarget );
        renderer.render( this.blurScene, this.blurCamera );

        return this.blurRenderTarget.texture;

    }

    /** Apply the native FILTER stage to an already composited frame. */
    processTexture( renderer, sourceTexture, outputTarget, time, width, height ) {

        let texture = sourceTexture;

        if ( this.blurEnabled ) {

            this.ensureBlurRenderTarget( width, height );
            texture = this.applyBlur( renderer, texture, time );

        }

        if ( this.lensEnabled || this.underwaterEnabled || this.wobbleEnabled ) {

            this.distortionMesh.material.uniforms.map.value = texture;
            this.resetDistortionMesh();
            if ( this.lensEnabled ) this.applyLensDistortion( time );
            if ( this.underwaterEnabled ) this.applyUnderwaterDistortion( time );
            if ( this.wobbleEnabled ) this.applyWobbleDistortion( time );
            renderer.setRenderTarget( outputTarget );
            renderer.render( this.distortionScene, this.distortionCamera );

        } else {

            this.outputMaterial.map = texture;
            renderer.setRenderTarget( outputTarget );
            renderer.render( this.outputScene, this.outputCamera );

        }

    }

}
