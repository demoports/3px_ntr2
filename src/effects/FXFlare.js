import * as THREE from 'three';
import { DemoEffect } from '../core/DemoEffect.js';
import { renderWithoutClearing } from '../engine/RenderUtils.js';

const NUM_RAYS = 300;
const NATIVE_RANDOM_DISCARD = 128;
const POSITION_VALUES_PER_RAY = 9;
const COLOR_VALUES_PER_RAY = 12;

function createNativeRandomValues() {

    // VC6's unseeded rand() sequence was deterministic. Shader initialization
    // consumed 128 values before FLARE_00 initialized.
    let seed = 1;
    const next = () => {

        seed = ( Math.imul( seed, 214013 ) + 2531011 ) >>> 0;
        return ( ( seed >>> 16 ) & 0x7fff ) / 0x7fff;

    };

    for ( let i = 0; i < NATIVE_RANDOM_DISCARD; i ++ ) next();

    const values = new Float32Array( NUM_RAYS );
    for ( let i = 0; i < NUM_RAYS; i ++ ) values[ i ] = next();
    return values;

}

/**
 * FXFlare - Lens flare / light ray effect
 * Renders animated rays emanating from a point
 */
export class FXFlare extends DemoEffect {

    constructor( name ) {

        super( name );

        // Flare position in the native 640x480 screen space.
        this.flareX = 320;
        this.flareY = 110;

        // Random values for each ray (generated once)
        this.randoms = createNativeRandomValues();

        // Scene for rendering flare
        this.scene = new THREE.Scene();
        // Orthographic camera for screen-space rendering (matching FXStill setup)
        // Camera at z=0 (default), near=0, far=1, vertices at z=0
        this.camera = new THREE.OrthographicCamera( 0, 640, 480, 0, 0, 1 );

        // Geometry for rays
        this.geometry = null;
        this.material = null;
        this.mesh = null;

        // Color settings (0xA0080803 = ARGB format: A=0xA0, R=0x08, G=0x08, B=0x03)
        // D3D diffuse 0xA0080803 stores raw framebuffer values. Constructing a
        // Three.js Color from the hex value performs an sRGB-to-linear conversion,
        // which makes these deliberately dim additive rays about 13x too dark.
        this.rayColor = new THREE.Color().setRGB( 8 / 255, 8 / 255, 3 / 255 );
        this.rayAlpha = 0.63; // 0xA0 / 255 ≈ 0.627

    }

    init() {

        // createEffects() initializes instances and the script's FXLOAD command
        // may initialize this one again. Keep initialization idempotent so a stale
        // zero-filled flare mesh is not left in the scene.
        if ( this.isInitialized ) return 0;

        super.init();

        // Create geometry for all rays
        // Each ray is a triangle (3 vertices)
        this.geometry = new THREE.BufferGeometry();

        const positions = new Float32Array( NUM_RAYS * POSITION_VALUES_PER_RAY );
        const colors = new Float32Array( NUM_RAYS * COLOR_VALUES_PER_RAY );

        this.geometry.setAttribute(
            'position',
            new THREE.BufferAttribute( positions, 3 ).setUsage( THREE.DynamicDrawUsage )
        );
        this.geometry.setAttribute(
            'vertexColor',
            new THREE.BufferAttribute( colors, 4 ).setUsage( THREE.DynamicDrawUsage )
        );
        this.updateRayColors();

        // Create material with vertex colors including alpha
        // C++ "flaretrace" shader: COLOR=PA_DIFFUSE, ALPHA=PA_DIFFUSE, BLEND=BL_ONE/BL_ONE
        // ZCMP=ALWAYS (depthTest always passes), ZWRITEENABLE=FALSE
        // Use custom attribute name 'vertexColor' to avoid conflict with Three.js built-in 'color'
        this.material = new THREE.ShaderMaterial( {
            vertexShader: `
                attribute vec4 vertexColor;
                varying vec4 vColor;
                void main() {
                    vColor = vertexColor;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
                }
            `,
            fragmentShader: `
                varying vec4 vColor;
                void main() {
                    gl_FragColor = vColor;
                }
            `,
            transparent: true,
            blending: THREE.CustomBlending,
            blendSrc: THREE.OneFactor,
            blendDst: THREE.OneFactor,
            blendSrcAlpha: THREE.OneFactor,
            blendDstAlpha: THREE.OneFactor,
            blendEquation: THREE.AddEquation,
            depthTest: false,
            depthWrite: false,
            side: THREE.DoubleSide
        } );

        this.mesh = new THREE.Mesh( this.geometry, this.material );
        this.mesh.frustumCulled = false;
        this.scene.add( this.mesh );

        return 0;

    }

    shutdown() {

        if ( this.geometry ) {

            this.geometry.dispose();
            this.geometry = null;

        }

        if ( this.material ) {

            this.material.dispose();
            this.material = null;

        }

        this.scene.clear();

        this.mesh = null;

        super.shutdown();
        return 0;

    }

    update( time ) {

        if ( ! this.isActive || ! this.geometry ) return this.isActive;

        const positions = this.geometry.attributes.position.array;

        const fx = this.flareX;
        // Convert from DirectX coords (Y down) to WebGL coords (Y up)
        const fy = 480 - this.flareY;

        for ( let i = 0; i < NUM_RAYS; i ++ ) {

            const random = this.randoms[ i ];

            // Calculate ray parameters (matching original algorithm)
            let rayLength = random * ( 200.0 + 150.0 * Math.cos( 3.0 * time + i * i ) );
            const rayArc = random * ( 0.2 + 0.01 * Math.sin( time + i ) );
            let rayOffset = random * ( 0.1 * time + 6.23 * Math.cos( 13.0 * i ) );

            const angle = Math.cos( rayOffset );

            rayOffset = Math.abs( rayOffset % ( Math.PI * 2.0 ) );
            if ( rayOffset >= Math.PI && rayOffset < 2.0 * Math.PI ) {

                rayLength *= Math.abs( angle );

            }

            // Vertex 0 - center point (bright)
            const v0 = i * POSITION_VALUES_PER_RAY;
            positions[ v0 ] = fx;
            positions[ v0 + 1 ] = fy;

            // Vertex 1 - outer point 1 (transparent)
            // Negate sin for Y to convert from DirectX (Y down) to WebGL (Y up)
            const v1 = v0 + 3;
            positions[ v1 ] = fx + rayLength * Math.cos( rayOffset );
            positions[ v1 + 1 ] = fy - rayLength * Math.sin( rayOffset );

            // Vertex 2 - outer point 2 (transparent)
            const v2 = v0 + 6;
            positions[ v2 ] = fx + rayLength * Math.cos( rayOffset + rayArc );
            positions[ v2 + 1 ] = fy - rayLength * Math.sin( rayOffset + rayArc );

        }

        this.geometry.attributes.position.needsUpdate = true;

        return this.isActive;

    }

    updateRayColors() {

        if ( ! this.geometry ) return;

        const colorAttribute = this.geometry.attributes.vertexColor;
        const colors = colorAttribute.array;

        for ( let i = 0; i < NUM_RAYS; i ++ ) {

            // The arrays are zero-filled, so only the center color changes.
            const offset = i * COLOR_VALUES_PER_RAY;
            colors[ offset ] = this.rayColor.r;
            colors[ offset + 1 ] = this.rayColor.g;
            colors[ offset + 2 ] = this.rayColor.b;
            colors[ offset + 3 ] = this.rayAlpha;

        }

        colorAttribute.needsUpdate = true;

    }

    render( renderer ) {

        if ( ! this.isActive ) return;

        renderWithoutClearing( renderer, this.scene, this.camera );

    }

    handleCommand( time, cmd, args ) {

        switch ( cmd ) {

            case 'POSITION':
                this.flareX = parseFloat( args[ 0 ] ) || 320;
                this.flareY = parseFloat( args[ 1 ] ) || 110;
                return 0;

            case 'COLOR':
                this.rayColor.setRGB(
                    parseFloat( args[ 0 ] ) || 0,
                    parseFloat( args[ 1 ] ) || 0,
                    parseFloat( args[ 2 ] ) || 0
                );
                this.rayAlpha = parseFloat( args[ 3 ] ) || 0.63;
                this.updateRayColors();
                return 0;

            case 'LAYER':
                this.setLayer( parseInt( args[ 0 ] ) || 0 );
                return 0;

            default:
                return super.handleCommand( time, cmd, args );

        }

    }

}
