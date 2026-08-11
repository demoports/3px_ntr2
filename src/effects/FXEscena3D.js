import * as THREE from 'three';
import { DemoEffect } from '../core/DemoEffect.js';
import { Loader3PX } from '../loaders/Loader3PX.js';
import { MaxScene } from '../engine/MaxScene.js';
import { shaderNoiseManager } from '../engine/ShaderNoiseManager.js';

// Blend factor mapping from 3PX shader definitions to Three.js
// Matches D3D8 D3DBLEND enum values from SM_Shader.h
const BLEND_FACTORS = {
    'BL_ZERO': THREE.ZeroFactor,
    'BL_ONE': THREE.OneFactor,
    'BL_SRCCOLOR': THREE.SrcColorFactor,
    'BL_INVSRCCOLOR': THREE.OneMinusSrcColorFactor,
    'BL_SRCALPHA': THREE.SrcAlphaFactor,
    'BL_INVSRCALPHA': THREE.OneMinusSrcAlphaFactor,
    'BL_DESTALPHA': THREE.DstAlphaFactor,
    'BL_INVDESTALPHA': THREE.OneMinusDstAlphaFactor,
    'BL_DESTCOLOR': THREE.DstColorFactor,
    'BL_INVDESTCOLOR': THREE.OneMinusDstColorFactor,
    'BL_SRCALPHASAT': THREE.SrcAlphaSaturateFactor,
    // BL_BOTHSRCALPHA and BL_BOTHINVSRCALPHA are special D3D modes - use SrcAlpha as fallback
    'BL_BOTHSRCALPHA': THREE.SrcAlphaFactor,
    'BL_BOTHINVSRCALPHA': THREE.OneMinusSrcAlphaFactor,
};

// Cull mode mapping from 3PX shader definitions to Three.js
// Note: DirectX uses CW front faces, OpenGL uses CCW, and we negated Z during conversion
// so the winding order flipped. CULL_CW in DirectX becomes FrontSide in Three.js.
const CULL_MODES = {
    'CULL_NONE': THREE.DoubleSide,
    'CULL_CW': THREE.FrontSide,
    'CULL_CCW': THREE.BackSide,
};

const PRIORITIES = {
    'PR_FIRST': 0,
    'PR_OPAQUE': 3,
    'PR_ADDITIVE': 6,
    'PR_ADDITIVE2': 7,
    'PR_ADDITIVE3': 8,
    'PR_TRANSPARENT': 12,
    'PR_TRANSPARENT2': 13,
    'PR_TRANSPARENT3': 14,
    'PR_LAST': 15
};

const MAX_LIGHTS = 8;

function toD3DColorChannel( value ) {

    return Math.floor( THREE.MathUtils.clamp( value, 0, 1 ) * 255 ) / 255;

}

function createLightUniforms() {

    const positions = [];
    const directions = [];
    const diffuseColors = [];
    const specularColors = [];
    const params = [];

    for ( let i = 0; i < MAX_LIGHTS; i ++ ) {

        positions.push( new THREE.Vector3() );
        directions.push( new THREE.Vector3( 0, - 1, 0 ) );
        diffuseColors.push( new THREE.Vector3() );
        specularColors.push( new THREE.Vector3() );
        params.push( new THREE.Vector4( 0, 0, 1, 0 ) );

    }

    return {
        numLights: { value: 0 },
        lightPositions: { value: positions },
        lightDirections: { value: directions },
        lightDiffuseColors: { value: diffuseColors },
        lightSpecularColors: { value: specularColors },
        lightParams: { value: params },
        lightAttenuation2: { value: new Float32Array( MAX_LIGHTS ) }
    };

}

function createLightData() {

    const uniforms = createLightUniforms();

    return {
        count: 0,
        positions: uniforms.lightPositions.value,
        directions: uniforms.lightDirections.value,
        diffuseColors: uniforms.lightDiffuseColors.value,
        specularColors: uniforms.lightSpecularColors.value,
        params: uniforms.lightParams.value,
        attenuation2: uniforms.lightAttenuation2.value
    };

}

function rebuildIndexedVertexNormals( record ) {

    const { geometry, position, normal, indexArray } = record;

    // Nature's NoiseXYZ meshes are all conventional indexed float buffers.
    // Keep Three.js's generic implementation as a safe fallback for any other
    // archive shape while using a zero-allocation typed-array loop here.
    if ( ! indexArray || position.isInterleavedBufferAttribute || normal.isInterleavedBufferAttribute ) {

        geometry.computeVertexNormals();
        return;

    }

    const positions = position.array;
    const normals = normal.array;
    normals.fill( 0 );

    for ( let i = 0; i < indexArray.length; i += 3 ) {

        const a = indexArray[ i ] * 3;
        const b = indexArray[ i + 1 ] * 3;
        const c = indexArray[ i + 2 ] * 3;

        const cbx = positions[ c ] - positions[ b ];
        const cby = positions[ c + 1 ] - positions[ b + 1 ];
        const cbz = positions[ c + 2 ] - positions[ b + 2 ];
        const abx = positions[ a ] - positions[ b ];
        const aby = positions[ a + 1 ] - positions[ b + 1 ];
        const abz = positions[ a + 2 ] - positions[ b + 2 ];

        const nx = cby * abz - cbz * aby;
        const ny = cbz * abx - cbx * abz;
        const nz = cbx * aby - cby * abx;

        normals[ a ] += nx;
        normals[ a + 1 ] += ny;
        normals[ a + 2 ] += nz;
        normals[ b ] += nx;
        normals[ b + 1 ] += ny;
        normals[ b + 2 ] += nz;
        normals[ c ] += nx;
        normals[ c + 1 ] += ny;
        normals[ c + 2 ] += nz;

    }

    for ( let i = 0; i < normals.length; i += 3 ) {

        const x = normals[ i ];
        const y = normals[ i + 1 ];
        const z = normals[ i + 2 ];
        const length = Math.sqrt( x * x + y * y + z * z ) || 1;
        const inverseLength = 1 / length;

        normals[ i ] = x * inverseLength;
        normals[ i + 1 ] = y * inverseLength;
        normals[ i + 2 ] = z * inverseLength;

    }

    normal.needsUpdate = true;

}

/**
 * FXEscena3D - 3D scene rendering effect
 * Loads and renders .3px scenes with camera animation
 */
export class FXEscena3D extends DemoEffect {

    constructor( name, dataArchive, textureLoader ) {

        super( name );

        this.dataArchive = dataArchive;
        this.textureLoader = textureLoader;

        this.loader = new Loader3PX();
        this.maxScene = new MaxScene();

        this.scene = new THREE.Scene();
        // render() explicitly updates world matrices before native depth
        // sorting, so the renderer does not need to traverse them a second time.
        this.scene.matrixWorldAutoUpdate = false;
        this.isLoaded = false;

        // Shader definitions loaded from shaders.txt
        this.shaderDefs = new Map();
        this.isVisible = true;

        this.animationOffset = 0;
        this.forwardLength = 0;
        this.startForward = 0;

        // Viewport settings (normalized 0-1)
        this.viewportA = { x: 0, y: 0, w: 1, h: 1 };
        this.viewportB = { x: 0, y: 0, w: 1, h: 1 };
        this.viewportTransition = false;
        this.viewportStartTime = 0;
        this.viewportDuration = 0;
        this.demoTime = 0;

        // Native vertex effects deform shared CPU buffers and rebuild their
        // normals before fixed-function lighting. Keep the source geometry so
        // those changes can be reproduced and restored exactly.
        this.noiseGeometries = new Map();

        // All custom materials use the scene's D3D-style point-light uniforms.
        this.lightMaterials = [];
        this.distortMaterials = [];

        // Per-frame scratch/caches. Keeping these stable avoids periodic GC
        // pauses during scene transitions.
        this._lightData = createLightData();
        this._sceneLights = [];
        this._sortMeshes = [];
        this._renderSize = new THREE.Vector2();
        this._sortCameraPosition = new THREE.Vector3();
        this._sortViewDirection = new THREE.Vector3();

    }

    shutdown() {

        this.maxScene.dispose();
        this.isLoaded = false;

        this.scene.clear();

        // Clear material tracking
        this.noiseGeometries.clear();
        this.lightMaterials = [];
        this.distortMaterials = [];
        this._sceneLights = [];
        this._sortMeshes = [];

        super.shutdown();
        return 0;

    }

    start( time ) {

        super.start( time );
        // startTime = currentTime - desiredAnimationTime
        // So that localTime = currentTime - startTime = desiredAnimationTime
        this.maxScene.setAnimationOffset( time - this.animationOffset );
        return 0;

    }

    resetPlaybackState() {

        this.isVisible = true;
        this.animationOffset = 0;
        this.forwardLength = 0;
        this.viewportA = { x: 0, y: 0, w: 1, h: 1 };
        this.viewportB = { x: 0, y: 0, w: 1, h: 1 };
        this.viewportTransition = false;
        this.maxScene.resetPlaybackState();

    }

    update( time, _deltaTime ) {

        this.demoTime = time;

        if ( ! this.isActive || ! this.isLoaded || ! this.isVisible ) {

            return this.isActive;

        }

        // Handle forward animation skip
        if ( this.forwardLength > 0 ) {

            const elapsed = time - this.startForward;
            const offset = 1.0 / ( 1.0 + Math.exp( - ( 75.0 * ( - 0.05 + elapsed ) ) ) );

            if ( offset > 0.99 ) {

                this.animationOffset += 1.0;
                this.maxScene.setAnimationOffset( time - this.animationOffset );
                this.forwardLength = 0;

            }

        }

        // Handle viewport transition
        if ( this.viewportTransition ) {

            const elapsed = time - this.viewportStartTime;
            const t = Math.min( 1.0, elapsed / this.viewportDuration );

            if ( t >= 1.0 ) {

                this.viewportTransition = false;
                this.viewportA = { ...this.viewportB };

            }

        }

        // Update scene animation
        this.maxScene.update( time );

        // The original engine enabled fixed-function lighting for every scene
        // containing lights. Update the shared uniforms once per scene frame.
        const lightData = this.collectSceneLights();

        for ( const material of this.lightMaterials ) {

            this.updateLightUniforms( material, lightData );

        }

        // Update distort-normal materials with current time.
        for ( const material of this.distortMaterials ) {

            material.uniforms.time.value = time;

        }

        for ( const shaderName of this.noiseGeometries.keys() ) {

            this.updateNoiseGeometry( shaderName, time );

        }

        return this.isActive;

    }

    render( renderer, scene, camera ) {

        if ( ! this.isLoaded || ! this.isVisible ) {

            return;

        }

        // Get current viewport
        let vx, vy, vw, vh;

        if ( this.viewportTransition ) {

            const elapsed = this.demoTime - this.viewportStartTime;
            const t = Math.min( 1.0, elapsed / this.viewportDuration );

            vx = this.viewportA.x + ( this.viewportB.x - this.viewportA.x ) * t;
            vy = this.viewportA.y + ( this.viewportB.y - this.viewportA.y ) * t;
            vw = this.viewportA.w + ( this.viewportB.w - this.viewportA.w ) * t;
            vh = this.viewportA.h + ( this.viewportB.h - this.viewportA.h ) * t;

        } else {

            vx = this.viewportB.x;
            vy = this.viewportB.y;
            vw = this.viewportB.w;
            vh = this.viewportB.h;

        }

        // Apply fog to the scene
        this.maxScene.applyFog( this.scene );

        // Use the scene's camera if available
        const renderCamera = this.maxScene.activeCamera || camera;

        // Native priority sorting used radial mesh depth rather than Three.js's
        // projected camera-space Z. Every element of a MAX mesh shared the
        // distance from its object origin to the camera, offset by the view axis.
        renderCamera.updateMatrixWorld();
        this.scene.updateMatrixWorld( true );
        const cameraPosition = this._sortCameraPosition;
        const viewDirection = this._sortViewDirection;
        renderCamera.getWorldPosition( cameraPosition );
        renderCamera.getWorldDirection( viewDirection );
        for ( const object of this._sortMeshes ) {

            const elements = object.matrixWorld.elements;
            const x = elements[ 12 ] - cameraPosition.x - viewDirection.x;
            const y = elements[ 13 ] - cameraPosition.y - viewDirection.y;
            const z = elements[ 14 ] - cameraPosition.z - viewDirection.z;
            object.userData.nativeDepth = Math.sqrt( x * x + y * y + z * z );

        }

        // Set viewport
        // WebGLRenderer.setViewport()/setScissor() take logical pixels and apply
        // the renderer pixel ratio internally. Using getDrawingBufferSize() here
        // applies that ratio twice on Retina/high-DPI displays and crops the scene.
        const size = renderer.getSize( this._renderSize );
        const px = Math.floor( vx * size.x );
        const py = Math.floor( ( 1 - vy - vh ) * size.y );
        const pw = Math.floor( vw * size.x );
        const ph = Math.floor( vh * size.y );

        renderer.setViewport( px, py, pw, ph );
        renderer.setScissor( px, py, pw, ph );
        renderer.setScissorTest( true );

        // Clear depth buffer before rendering (like MaxScene::ClearZ in the original)
        renderer.clearDepth();

        // Render
        renderer.render( this.scene, renderCamera );

        // Reset viewport
        renderer.setViewport( 0, 0, size.x, size.y );
        renderer.setScissorTest( false );

    }

    handleCommand( time, cmd, args ) {

        switch ( cmd ) {

            case 'LOAD':
                return this.loadScene( args[ 0 ] );

            case 'SHOW':
                this.isVisible = true;
                return 0;

            case 'HIDE':
                this.isVisible = false;
                return 0;

            case 'SETTIME':
                this.animationOffset = parseFloat( args[ 0 ] ) || 0;
                // startTime = currentTime - desiredAnimationTime
                // So that localTime = currentTime - startTime = desiredAnimationTime
                this.maxScene.setAnimationOffset( time - this.animationOffset );
                return 0;

            case 'CAMERA':
                this.maxScene.setCamera( args[ 0 ] );
                return 0;

            case 'FOG':
                if ( args[ 0 ]?.toUpperCase() === 'ON' ) {

                    const near = parseFloat( args[ 1 ] ) || 0;
                    const far = parseFloat( args[ 2 ] ) || 1000;
                    const r = parseFloat( args[ 3 ] ) || 0;
                    const g = parseFloat( args[ 4 ] ) || 0;
                    const b = parseFloat( args[ 5 ] ) || 0;

                    // D3DCOLOR_XRGB truncated script floats to 8-bit channels.
                    const fogColor = new THREE.Color(
                        toD3DColorChannel( r ),
                        toD3DColorChannel( g ),
                        toD3DColorChannel( b )
                    );
                    this.maxScene.setFog( true, near, far, fogColor );

                } else {

                    this.maxScene.setFog( false );

                }
                return 0;

            case 'VIEWPORT':
                this.viewportB = {
                    x: ( parseFloat( args[ 0 ] ) || 0 ) / 640,
                    y: ( parseFloat( args[ 1 ] ) || 0 ) / 480,
                    w: ( parseFloat( args[ 2 ] ) || 640 ) / 640,
                    h: ( parseFloat( args[ 3 ] ) || 480 ) / 480
                };
                this.viewportA = { ...this.viewportB };
                return 0;

            case 'VIEWPORTMORPH':
                this.viewportA = { ...this.viewportB };
                this.viewportB = {
                    x: ( parseFloat( args[ 0 ] ) || 0 ) / 640,
                    y: ( parseFloat( args[ 1 ] ) || 0 ) / 480,
                    w: ( parseFloat( args[ 2 ] ) || 640 ) / 640,
                    h: ( parseFloat( args[ 3 ] ) || 480 ) / 480
                };
                this.viewportDuration = parseFloat( args[ 4 ] ) || 1.0;
                this.viewportStartTime = time;
                this.viewportTransition = true;
                return 0;

            case 'NOISE':
                this.maxScene.setNoise(
                    parseFloat( args[ 0 ] ) || 0,
                    parseFloat( args[ 1 ] ) || 0,
                    parseFloat( args[ 2 ] ) || 0,
                    time,
                    parseFloat( args[ 3 ] ) || 0
                );
                return 0;

            case 'FORWARD':
                this.forwardLength = 1.0;
                this.startForward = time;
                return 0;

            case 'LAYER':
                this.setLayer( parseInt( args[ 0 ] ) || 0 );
                return 0;

            default:
                return super.handleCommand( time, cmd, args );

        }

    }

    /**
     * Load a .3px scene file
     */
    async loadScene( filename ) {

        if ( ! filename ) return - 1;

        // Strip .txt extension if present and construct path
        const baseName = filename.toLowerCase().replace( /\.txt$/i, '' );
        const path = `data/scenesbin/${baseName}.3px`;

        try {

            // Get file data from archive
            const buffer = await this.dataArchive.getFile( path );

            if ( ! buffer ) {

                return - 1;

            }

            // Parse the .3px file
            const data = this.loader.parse( buffer );

            // Build Three.js scene objects
            const sceneData = this.loader.buildScene( data );

            // Load into MaxScene
            this.maxScene.load( sceneData );

            // Add to our Three.js scene
            this.scene.add( this.maxScene.group );
            this._sceneLights = this.maxScene.lightObjects.filter( Boolean );
            this._sortMeshes.length = 0;
            this.maxScene.group.traverse( object => {

                if ( object.isMesh ) this._sortMeshes.push( object );

            } );

            // Load shader definitions (only once)
            if ( this.shaderDefs.size === 0 ) {

                await this.loadShaderDefinitions();

            }

            // Load textures for materials
            await this.loadTextures( sceneData );

            this.isLoaded = true;

            return 0;

        } catch ( e ) {

            console.error( `${this.name}: Failed to load scene "${filename}"`, e );
            return - 1;

        }

    }

    /**
     * Load textures for scene materials
     */
    async loadTextures( sceneData ) {

        if ( ! this.textureLoader ) return;

        // First pass: collect all meshes grouped by material name
        const meshesByMaterial = new Map();

        for ( const meshData of sceneData.meshes ) {

            const mesh = sceneData.meshMap.get( meshData );

            if ( ! mesh ) continue;

            mesh.traverse( child => {

                if ( child.isMesh && child.material ) {

                    const materialName = child.material.userData.materialName;

                    if ( materialName ) {

                        let meshChildren = meshesByMaterial.get( materialName );

                        if ( ! meshChildren ) {

                            meshChildren = [];
                            meshesByMaterial.set( materialName, meshChildren );

                        }

                        meshChildren.push( child );

                    }

                }

            } );

        }

        await Promise.all( [ ...meshesByMaterial ].map(
            ( [ materialName, meshChildren ] ) => this.loadMaterialTextureForMeshes( materialName, meshChildren )
        ) );

    }

    /**
     * Load texture for a material and apply to all meshes using it
     */
    async loadMaterialTextureForMeshes( materialName, meshChildren ) {

        const nameLower = materialName.toLowerCase();

        // Check if we have a shader definition for this material
        const shaderDef = this.shaderDefs.get( nameLower );

        // Determine texture name from shader definition or material name
        const textureName = shaderDef?.texture ?? nameLower;

        // Try to load RGB texture
        const rgbPath = `data/textures/${textureName}@rgb.jpg`;
        const alphaPath = `data/textures/${textureName}@alpha.jpg`;
        const basePath = `data/textures/${textureName}.jpg`;

        try {

            let texture = null;
            let alphaTexture = null;
            let hasAlpha = false;

            // Try RGB + Alpha pair first
            const rgbBuffer = await this.dataArchive.getFile( rgbPath );

            if ( rgbBuffer ) {

                const alphaBuffer = await this.dataArchive.getFile( alphaPath );

                if ( alphaBuffer ) {

                    // Load RGB and Alpha as separate textures
                    texture = await this.textureLoader.loadFromBuffer( rgbBuffer, rgbPath, { flipY: false } );
                    alphaTexture = await this.textureLoader.loadFromBuffer( alphaBuffer, alphaPath, { flipY: false } );
                    hasAlpha = true;

                } else {

                    texture = await this.textureLoader.loadFromBuffer( rgbBuffer, rgbPath, { flipY: false } );

                }

            } else {

                // Try base path
                const baseBuffer = await this.dataArchive.getFile( basePath );

                if ( baseBuffer ) {

                    texture = await this.textureLoader.loadFromBuffer( baseBuffer, basePath, { flipY: false } );

                }

            }

            // Create the appropriate material based on shader definition
            let newMaterial = null;
            // Only use vertex colors when explicitly specified in shader definition
            const useVertexColors = shaderDef?.modulateVertexColors ?? false;
            // C++ default: use vertex alpha (PA_DIFFUSE), not texture alpha
            const useTextureAlpha = shaderDef?.useTextureAlpha ?? false;

            // If shader has distort normal, use custom distort material
            if ( shaderDef && shaderDef.hasDistortNormal && texture ) {

                newMaterial = this.createDistortNormalMaterial(
                    texture,
                    hasAlpha,
                    useVertexColors,
                    shaderDef.specularPower,
                    alphaTexture,
                    useTextureAlpha
                );

            // For textured materials, use noise-capable material (supports sphere mapping too)
            } else if ( texture ) {

                const useSphereMap = shaderDef?.isSphereMap ?? false;
                const isAdditive = shaderDef?.isAdditive ?? false;
                newMaterial = this.createNoiseMaterial( texture, hasAlpha, nameLower, useVertexColors, useSphereMap, isAdditive, alphaTexture, useTextureAlpha );

            // For materials with TFACTORCOLOR but no texture (solid color materials like "negro")
            } else if ( shaderDef && shaderDef.tfactorColor ) {

                newMaterial = new THREE.MeshBasicMaterial( {
                    color: new THREE.Color( shaderDef.tfactorColor.r, shaderDef.tfactorColor.g, shaderDef.tfactorColor.b ),
                    fog: true
                } );

            }

            if ( newMaterial ) {

                newMaterial.userData.materialName = materialName;
                this.configureMaterial( newMaterial, shaderDef );

            }

            // Apply to all meshes using this material
            for ( const meshChild of meshChildren ) {

                if ( newMaterial ) {

                    // Use the new specialized material
                    const previousMaterial = meshChild.material;
                    meshChild.material = newMaterial;
                    if ( previousMaterial !== newMaterial ) previousMaterial.dispose();

                    if ( newMaterial.userData.noiseShaderName ) {

                        this.registerNoiseGeometry(
                            newMaterial.userData.noiseShaderName,
                            meshChild
                        );

                    }

                } else {

                    this.configureMaterial( meshChild.material, shaderDef );

                }

                meshChild.renderOrder = shaderDef?.priority ?? 3;

            }

        } catch ( e ) {

            console.warn( `Failed to load texture for material ${materialName}:`, e );

        }

    }

    configureMaterial( material, shaderDef ) {

        // C++ defaults: opaque BL_ONE/BL_ZERO, CULL_CW, depth write and LESSEQUAL.
        const srcFactor = BLEND_FACTORS[ shaderDef?.blendSrc || 'BL_ONE' ];
        const dstFactor = BLEND_FACTORS[ shaderDef?.blendDst || 'BL_ZERO' ];

        if ( srcFactor !== undefined && dstFactor !== undefined ) {

            material.transparent = true;
            material.depthWrite = true;

            if ( srcFactor === THREE.OneFactor && dstFactor === THREE.ZeroFactor ) {

                material.blending = THREE.NoBlending;

            } else {

                material.blending = THREE.CustomBlending;
                material.blendSrc = srcFactor;
                material.blendDst = dstFactor;
                material.blendSrcAlpha = srcFactor;
                material.blendDstAlpha = dstFactor;

            }

            material.needsUpdate = true;

        }

        material.side = CULL_MODES[ shaderDef?.cullMode || 'CULL_CW' ] ?? THREE.FrontSide;
        material.userData.shaderOrder = shaderDef?.order ?? Number.MAX_SAFE_INTEGER;

        if ( ( shaderDef?.priority ?? 3 ) >= 12 ) material.transparent = true;
        if ( shaderDef?.noZWrite ) material.depthWrite = false;

        material.depthFunc = shaderDef?.zCmp === 'ALWAYS'
            ? THREE.AlwaysDepth
            : THREE.LessEqualDepth;

    }

    /**
     * Load and parse shader definitions from all .txt files in data/shaders/
     */
    async loadShaderDefinitions() {

        const shaderFiles = this.dataArchive.getFileList().filter( path =>
            path.startsWith( 'data/shaders/' ) && path.endsWith( '.txt' )
        );

        for ( const shaderFile of shaderFiles ) {

            try {

                const text = await this.dataArchive.getFileAsText( shaderFile );

                if ( text ) {

                    this.parseShaderDefinitions( text );

                }

            } catch ( e ) {

                console.warn( `Failed to load ${shaderFile}:`, e );

            }

        }

    }

    /**
     * Parse shader definitions text
     */
    parseShaderDefinitions( text ) {

        // Simple parser for shader definitions
        // Match </> only when it's on its own line (shader-closing), not inline like <DISTORTNORMAL></>
        const shaderRegex = /<SHADER>([\s\S]*?)(?:<\/SHADER>|\n<\/>)/gi;
        let match;

        while ( ( match = shaderRegex.exec( text ) ) !== null ) {

            const shaderBlock = match[ 1 ];

            // Extract shader name
            const nameMatch = /<NAME>\s*"([^"]+)"/i.exec( shaderBlock );

            if ( ! nameMatch ) continue;

            const shaderName = nameMatch[ 1 ].toLowerCase();

            // Extract texture name
            const textureMatch = /<TEXTURE>\s*"([^"]+)"/i.exec( shaderBlock );
            const textureName = textureMatch ? textureMatch[ 1 ].toLowerCase() : shaderName;

            // Check for texture generation mode - value may be on separate line
            const texGenMatch = /<TEXGEN>[\s\S]*?<TYPE>[\s\S]*?"([^"]+)"/i.exec( shaderBlock );
            const texGen = texGenMatch ? texGenMatch[ 1 ] : null;

            // Check for blend mode - values may be on separate lines
            const blendSrcMatch = /<BLEND>[\s\S]*?<SRC>[\s\S]*?"([^"]+)"/i.exec( shaderBlock );
            const blendSrc = blendSrcMatch ? blendSrcMatch[ 1 ] : null;

            const blendDstMatch = /<BLEND>[\s\S]*?<DST>[\s\S]*?"([^"]+)"/i.exec( shaderBlock );
            const blendDst = blendDstMatch ? blendDstMatch[ 1 ] : null;

            // Check for normal distortion
            const hasDistortNormal = /<DISTORTNORMAL>/i.test( shaderBlock );

            // Check for NOZWRITE (disable depth writing)
            const noZWrite = /<NOZWRITE>/i.test( shaderBlock );

            // Check for ZCMP (depth comparison function) - value may be on separate line
            // C++ default is ZC_LESSEQUAL, ALWAYS means depth test always passes
            const zcmpMatch = /<ZCMP>[\s\S]*?"([^"]+)"/i.exec( shaderBlock );
            const zCmp = zcmpMatch ? zcmpMatch[ 1 ].toUpperCase() : 'LESSEQUAL';

            // Check for cull mode (default is CULL_CW in C++) - value may be on separate line
            const cullMatch = /<CULL>[\s\S]*?"([^"]+)"/i.exec( shaderBlock );
            const cullMode = cullMatch ? cullMatch[ 1 ].toUpperCase() : 'CULL_CW';

            // Check for TFACTORCOLOR (constant color, e.g., for solid color materials)
            const tfactorMatch = /<TFACTORCOLOR>[\s\S]*?<RGB>\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/i.exec( shaderBlock );
            const tfactorColor = tfactorMatch ? {
                r: parseFloat( tfactorMatch[ 1 ] ),
                g: parseFloat( tfactorMatch[ 2 ] ),
                b: parseFloat( tfactorMatch[ 3 ] )
            } : null;

            // Check for PRIORITY (render order) - value may be on separate line
            const priorityMatch = /<PRIORITY>[\s\S]*?"([^"]+)"/i.exec( shaderBlock );
            const priority = priorityMatch ? ( PRIORITIES[ priorityMatch[ 1 ] ] ?? 3 ) : 3;

            // Check for COLOR operation (how texture and vertex colors combine) - values may be on separate lines
            // C++ defaults: ColorOp=PO_MODULATE, ColorArg1=PA_TEXTURE, ColorArg2=PA_DIFFUSE
            const colorOpMatch = /<COLOR>[\s\S]*?<OP>[\s\S]*?"([^"]+)"/i.exec( shaderBlock );
            const colorArg1Match = /<COLOR>[\s\S]*?<ARG1>[\s\S]*?"([^"]+)"/i.exec( shaderBlock );
            const colorArg2Match = /<COLOR>[\s\S]*?<ARG2>[\s\S]*?"([^"]+)"/i.exec( shaderBlock );

            const colorOp = colorOpMatch ? colorOpMatch[ 1 ] : 'PO_MODULATE';
            const colorArg1 = colorArg1Match ? colorArg1Match[ 1 ] : 'PA_TEXTURE';
            const colorArg2 = colorArg2Match ? colorArg2Match[ 1 ] : 'PA_DIFFUSE';

            // Check for ALPHA operation - values may be on separate lines
            // C++ defaults: AlphaOp=PO_SELECTARG1, AlphaArg1=PA_DIFFUSE (vertex alpha, NOT texture!)
            const alphaOpMatch = /<ALPHA>[\s\S]*?<OP>[\s\S]*?"([^"]+)"/i.exec( shaderBlock );
            const alphaArg1Match = /<ALPHA>[\s\S]*?<ARG1>[\s\S]*?"([^"]+)"/i.exec( shaderBlock );
            const alphaArg2Match = /<ALPHA>[\s\S]*?<ARG2>[\s\S]*?"([^"]+)"/i.exec( shaderBlock );

            const alphaOp = alphaOpMatch ? alphaOpMatch[ 1 ] : 'PO_SELECTARG1';
            const alphaArg1 = alphaArg1Match ? alphaArg1Match[ 1 ] : 'PA_DIFFUSE';
            const alphaArg2 = alphaArg2Match ? alphaArg2Match[ 1 ] : 'PA_DIFFUSE';

            // Determine if we need vertex colors for color calculation
            const modulateVertexColors = colorOp === 'PO_MODULATE' &&
                ( ( colorArg1 === 'PA_TEXTURE' && colorArg2 === 'PA_DIFFUSE' ) ||
                  ( colorArg1 === 'PA_DIFFUSE' && colorArg2 === 'PA_TEXTURE' ) );

            // Determine alpha source (texture vs vertex)
            // If alphaArg1 is PA_TEXTURE, use texture alpha; otherwise use vertex alpha (default)
            const useTextureAlpha = ( alphaOp === 'PO_SELECTARG1' && alphaArg1 === 'PA_TEXTURE' ) ||
                                    ( alphaOp === 'PO_SELECTARG2' && alphaArg2 === 'PA_TEXTURE' ) ||
                                    ( alphaOp === 'PO_MODULATE' && ( alphaArg1 === 'PA_TEXTURE' || alphaArg2 === 'PA_TEXTURE' ) );

            // Check for LIGHTING/POWER (specular power) - value may be on separate line
            const powerMatch = /<LIGHTING>[\s\S]*?<POWER>[\s\S]*?([\d.]+)/i.exec( shaderBlock );
            const specularPower = powerMatch ? parseFloat( powerMatch[ 1 ] ) : 0;

            // Store shader definition
            this.shaderDefs.set( shaderName, {
                order: this.shaderDefs.size,
                texture: textureName,
                blendSrc,
                blendDst,
                cullMode,
                tfactorColor,
                priority,
                noZWrite,
                zCmp,
                modulateVertexColors,
                useTextureAlpha,
                specularPower,
                isSphereMap: texGen === 'TG_SPHEREREFLECTION',
                isAdditive: blendSrc === 'BL_ONE' && blendDst === 'BL_ONE',
                hasDistortNormal
            } );

        }

    }

    /**
     * Create a material with distorted normals (animated wave effect)
     * Supports D3D-style multi-light specular when specularPower > 0
     */
    createDistortNormalMaterial( texture, hasAlpha, useVertexColors = false, specularPower = 0, alphaTexture = null, useTextureAlpha = false ) {

        const material = new THREE.ShaderMaterial( {
            uniforms: THREE.UniformsUtils.merge( [
                THREE.UniformsLib.fog,
                {
                    map: { value: texture },
                    alphaMap: { value: alphaTexture },
                    time: { value: 0.0 },
                    specularPower: { value: specularPower }
                },
                createLightUniforms()
            ] ),
            vertexShader: `
                uniform float time;
                uniform float specularPower;
                uniform int numLights;
                uniform vec3 lightPositions[8];
                uniform vec3 lightDirections[8];
                uniform vec3 lightDiffuseColors[8];
                uniform vec3 lightSpecularColors[8];
                uniform vec4 lightParams[8];
                uniform float lightAttenuation2[8];

                attribute vec4 color;
                varying vec2 vUv;
                varying vec3 vNormal;
                varying vec3 vViewPosition;
                varying vec4 vColor;
                varying vec3 vLitDiffuse;
                varying vec3 vLitSpecular;
                varying float vFogDepth;

                void main() {
                    vUv = uv;
                    vColor = color;

                    // Distort normal based on vertex index and time
                    // Matches C++: v3d(cos(2*fTime+3*i)*sin(fTime+5*i)*0.5, 5.0, sin(fTime+i)*cos(fTime+7*i)*0.5)
                    float fTime = 2.0 * time;
                    float i = float(gl_VertexID);

                    vec3 distortedNormal = vec3(
                        cos(2.0 * fTime + 3.0 * i) * sin(fTime + 5.0 * i) * 0.5,
                        5.0,
                        -sin(fTime + i) * cos(fTime + 7.0 * i) * 0.5
                    );
                    distortedNormal = normalize(distortedNormal);

                    // Transform distorted normal to view space
                    vec3 viewNormal = normalize(normalMatrix * distortedNormal);
                    vNormal = viewNormal;

                    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
                    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                    vViewPosition = mvPosition.xyz;
                    vFogDepth = -mvPosition.z;

                    // DoDistort() forced the native vertex diffuse color to
                    // white. D3D then evaluated ambient, diffuse and specular
                    // per vertex before the texture stage.
                    vec3 litDiffuse = vec3(1.0);
                    vec3 litSpecular = vec3(0.0);

                    if (numLights > 0) {
                        vec3 ambientSum = vec3(0.0);
                        vec3 diffuseSum = vec3(0.0);
                        vec3 viewDirection = normalize(-mvPosition.xyz);

                        for (int lightIndex = 0; lightIndex < 8; lightIndex++) {
                            if (lightIndex >= numLights) break;

                            float lightType = lightParams[lightIndex].x;
                            float lightRange = lightParams[lightIndex].y;
                            float attenuation = 1.0;
                            vec3 lightDirection;

                            if (lightType > 2.5) {
                                lightDirection = normalize(-lightDirections[lightIndex]);
                            } else {
                                vec3 lightVector = lightPositions[lightIndex] - worldPosition.xyz;
                                float distanceToLight = length(lightVector);
                                lightDirection = distanceToLight > 0.0
                                    ? lightVector / distanceToLight
                                    : vec3(0.0, 1.0, 0.0);

                                if (lightRange > 0.0 && distanceToLight > lightRange) {
                                    attenuation = 0.0;
                                } else {
                                    attenuation = 1.0 / max(
                                        lightParams[lightIndex].z +
                                        lightParams[lightIndex].w * distanceToLight +
                                        lightAttenuation2[lightIndex] * distanceToLight * distanceToLight,
                                        0.001
                                    );
                                }
                            }

                            vec3 viewLightDirection = normalize(mat3(viewMatrix) * lightDirection);
                            float normalDotLight = max(dot(viewNormal, viewLightDirection), 0.0);

                            // D3DLight::Load replaced every serialized ambient
                            // color with (0.5, 0.5, 0.5).
                            ambientSum += vec3(0.5) * attenuation;
                            diffuseSum += lightDiffuseColors[lightIndex] * normalDotLight * attenuation;

                            if (specularPower > 0.0 && normalDotLight > 0.0) {
                                vec3 halfDirection = normalize(viewLightDirection + viewDirection);
                                float specular = pow(max(dot(viewNormal, halfDirection), 0.0), specularPower);
                                litSpecular += lightSpecularColors[lightIndex] * specular * attenuation;
                            }
                        }

                        litDiffuse = clamp(ambientSum + diffuseSum, 0.0, 1.0);
                        litSpecular = clamp(litSpecular, 0.0, 1.0);
                    }

                    vLitDiffuse = litDiffuse;
                    vLitSpecular = litSpecular;
                    gl_Position = projectionMatrix * mvPosition;
                }
            `,
            fragmentShader: `
                uniform sampler2D map;
                uniform sampler2D alphaMap;
                uniform vec3 fogColor;
                uniform float fogNear;
                uniform float fogFar;
                varying vec2 vUv;
                varying vec3 vNormal;
                varying vec3 vViewPosition;
                varying vec4 vColor;
                varying vec3 vLitDiffuse;
                varying vec3 vLitSpecular;
                varying float vFogDepth;

                void main() {
                    // Compute reflection vector for TG_CAMERAREFLECTION
                    // In view space, camera is at origin, so view direction is normalize(vViewPosition)
                    vec3 viewDir = normalize(vViewPosition);
                    vec3 normal = normalize(vNormal);
                    vec3 reflectVec = reflect(viewDir, normal);

                    // Use reflection vector for texture coords (matches D3D transform matrix)
                    vec2 envUV = vec2(
                        reflectVec.x * 0.5 + 0.5,
                        reflectVec.y * -0.5 + 0.5
                    );

                    vec4 texColor = texture2D(map, envUV, -1.0);

                    // Alpha source: C++ default is PA_DIFFUSE (vertex alpha), not texture alpha
                    // Only use texture alpha if shader explicitly specifies PA_TEXTURE for alpha
                    ${alphaTexture
                        ? 'float alphaValue = texture2D(alphaMap, envUV, -1.0).r;'
                        : ( useTextureAlpha
                            ? 'float alphaValue = texColor.a;'
                            : 'float alphaValue = vColor.a;' )}
                    texColor.a = alphaValue;

                    // The texture stage consumes D3DTA_DIFFUSE, then D3D adds
                    // the separately interpolated specular channel.
                    ${useVertexColors ? 'texColor.rgb *= vLitDiffuse;' : ''}
                    texColor.rgb += vLitSpecular;

                    // Apply fog
                    #ifdef USE_FOG
                        float fogFactor = clamp((vFogDepth - fogNear) / (fogFar - fogNear), 0.0, 1.0);
                        texColor.rgb = mix(texColor.rgb, fogColor, fogFactor);
                    #endif

                    gl_FragColor = texColor;
                }
            `,
            transparent: hasAlpha,
            fog: true
        } );

        this.distortMaterials.push( material );
        this.lightMaterials.push( material );

        return material;

    }

    /**
     * Create a material with noise vertex displacement (supports sphere mapping)
     */
    createNoiseMaterial( texture, hasAlpha, shaderName, useVertexColors = false, useSphereMap = false, isAdditive = false, alphaTexture = null, useTextureAlpha = false ) {

        const material = new THREE.ShaderMaterial( {
            uniforms: THREE.UniformsUtils.merge( [
                THREE.UniformsLib.fog,
                {
                    map: { value: texture },
                    alphaMap: { value: alphaTexture }
                },
                createLightUniforms()
            ] ),
            vertexShader: `
                uniform int numLights;
                uniform vec3 lightPositions[8];
                uniform vec3 lightDirections[8];
                uniform vec3 lightDiffuseColors[8];
                uniform vec4 lightParams[8];
                uniform float lightAttenuation2[8];

                attribute vec4 color;
                varying vec2 vUv;
                varying vec3 vNormal;
                varying vec4 vColor;
                varying vec3 vLitDiffuse;
                varying float vFogDepth;

                void main() {
                    vUv = uv;
                    vColor = color;

                    // NoiseXYZ updates the CPU position/normal buffers before
                    // this shader runs, just as the native vertex processor did.
                    vec3 viewNormal = normalize(normalMatrix * normal);
                    vNormal = viewNormal;

                    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
                    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                    vFogDepth = -mvPosition.z;

                    vec3 litDiffuse = color.rgb;

                    if (numLights > 0) {
                        vec3 ambientSum = vec3(0.0);
                        vec3 diffuseSum = vec3(0.0);

                        for (int lightIndex = 0; lightIndex < 8; lightIndex++) {
                            if (lightIndex >= numLights) break;

                            float lightType = lightParams[lightIndex].x;
                            float lightRange = lightParams[lightIndex].y;
                            float attenuation = 1.0;
                            vec3 lightDirection;

                            if (lightType > 2.5) {
                                lightDirection = normalize(-lightDirections[lightIndex]);
                            } else {
                                vec3 lightVector = lightPositions[lightIndex] - worldPosition.xyz;
                                float distanceToLight = length(lightVector);
                                lightDirection = distanceToLight > 0.0
                                    ? lightVector / distanceToLight
                                    : vec3(0.0, 1.0, 0.0);

                                if (lightRange > 0.0 && distanceToLight > lightRange) {
                                    attenuation = 0.0;
                                } else {
                                    attenuation = 1.0 / max(
                                        lightParams[lightIndex].z +
                                        lightParams[lightIndex].w * distanceToLight +
                                        lightAttenuation2[lightIndex] * distanceToLight * distanceToLight,
                                        0.001
                                    );
                                }
                            }

                            vec3 viewLightDirection = normalize(mat3(viewMatrix) * lightDirection);
                            float normalDotLight = max(dot(viewNormal, viewLightDirection), 0.0);
                            ambientSum += vec3(0.5) * attenuation;
                            diffuseSum += lightDiffuseColors[lightIndex] * normalDotLight * attenuation;
                        }

                        // Ambient material is white; diffuse material comes from COLOR1.
                        litDiffuse = clamp(ambientSum + color.rgb * diffuseSum, 0.0, 1.0);
                    }

                    vLitDiffuse = litDiffuse;
                    gl_Position = projectionMatrix * mvPosition;
                }
            `,
            fragmentShader: `
                uniform sampler2D map;
                uniform sampler2D alphaMap;
                uniform vec3 fogColor;
                uniform float fogNear;
                uniform float fogFar;

                varying vec2 vUv;
                varying vec3 vNormal;
                varying vec4 vColor;
                varying vec3 vLitDiffuse;
                varying float vFogDepth;

                void main() {
                    // Use sphere mapping or regular UVs
                    // Sphere mapping: u = Nx * 0.5 + 0.5, v = 0.5 - Ny * 0.5 (Y negated per D3D matrix)
                    ${useSphereMap
                        ? 'vec2 texUV = vec2(vNormal.x * 0.5 + 0.5, 0.5 - vNormal.y * 0.5);'
                        : 'vec2 texUV = vUv;'}

                    vec4 texColor = texture2D(map, texUV, -1.0);

                    // Alpha handling (not needed for additive blending where alpha is ignored)
                    ${! isAdditive ? ( alphaTexture
                        ? 'texColor.a = texture2D(alphaMap, texUV, -1.0).r;'
                        : ( useTextureAlpha
                            ? ''  // texture alpha is already in texColor.a
                            : 'texColor.a = vColor.a;' ) ) : ''}

                    // Modulate by the lit D3DTA_DIFFUSE channel when selected.
                    ${useVertexColors ? 'texColor.rgb *= vLitDiffuse;' : ''}

                    #ifdef USE_FOG
                        float fogFactor = clamp((vFogDepth - fogNear) / (fogFar - fogNear), 0.0, 1.0);
                        texColor.rgb = mix(texColor.rgb, fogColor, fogFactor);
                    #endif

                    gl_FragColor = texColor;
                }
            `,
            transparent: hasAlpha,
            fog: true
        } );

        material.userData.noiseShaderName = shaderName;
        this.lightMaterials.push( material );

        return material;

    }

    registerNoiseGeometry( shaderName, mesh ) {

        const geometry = mesh.geometry;
        const position = geometry.getAttribute( 'position' );
        const normal = geometry.getAttribute( 'normal' );

        if ( ! position || ! normal ) return;

        if ( ! this.noiseGeometries.has( shaderName ) ) {

            this.noiseGeometries.set( shaderName, [] );

        }

        const records = this.noiseGeometries.get( shaderName );
        if ( records.some( record => record.geometry === geometry ) ) return;

        // D3D kept culling against the exported, undeformed geometry sphere.
        // Cache Three.js's equivalent before any dynamic positions are written.
        if ( ! geometry.boundingSphere ) geometry.computeBoundingSphere();
        position.setUsage( THREE.DynamicDrawUsage );
        normal.setUsage( THREE.DynamicDrawUsage );
        const basePositions = position.array.slice();
        const basePhase = new Float64Array( position.count );

        for ( let i = 0; i < position.count; i ++ ) {

            const offset = i * 3;
            basePhase[ i ] = basePositions[ offset ] +
                basePositions[ offset + 1 ] - basePositions[ offset + 2 ];

        }

        records.push( {
            geometry,
            position,
            normal,
            indexArray: geometry.index?.array || null,
            basePositions,
            baseNormals: normal.array.slice(),
            basePhase,
            isDeformed: false
        } );

    }

    updateNoiseGeometry( shaderName, time ) {

        const records = this.noiseGeometries.get( shaderName );
        if ( ! records ) return;

        const params = shaderNoiseManager.getNoise( shaderName );
        const scale = shaderNoiseManager.getNoiseScale( shaderName, time );

        for ( const record of records ) {

            const { position, normal, basePositions, baseNormals, basePhase } = record;

            if ( ! params || scale === 0 ) {

                if ( record.isDeformed ) {

                    position.array.set( basePositions );
                    normal.array.set( baseNormals );
                    position.needsUpdate = true;
                    normal.needsUpdate = true;
                    record.isDeformed = false;

                }

                continue;

            }

            const positions = position.array;

            for ( let i = 0; i < position.count; i ++ ) {

                const offset = i * 3;
                const x = basePositions[ offset ];
                const y = basePositions[ offset + 1 ];
                const z = basePositions[ offset + 2 ];
                const code = scale * Math.sin(
                    params.spaceFrequency * basePhase[ i ] +
                    params.timeFrequency * time
                );

                positions[ offset ] = x + params.amplitudeX * code;
                positions[ offset + 1 ] = y + params.amplitudeY * code;
                positions[ offset + 2 ] = z - params.amplitudeZ * code;

            }

            position.needsUpdate = true;
            // NoiseXYZShader accumulated each deformed triangle normal into its
            // vertices and normalized the result. BufferGeometry does the same
            // indexed calculation after the left-to-right-handed conversion.
            rebuildIndexedVertexNormals( record );
            record.isDeformed = true;

        }

    }

    updateLightUniforms( material, lightData ) {

        const uniforms = material.uniforms;
        uniforms.numLights.value = lightData.count;
        uniforms.lightPositions.value = lightData.positions;
        uniforms.lightDirections.value = lightData.directions;
        uniforms.lightDiffuseColors.value = lightData.diffuseColors;
        uniforms.lightSpecularColors.value = lightData.specularColors;
        uniforms.lightParams.value = lightData.params;
        uniforms.lightAttenuation2.value = lightData.attenuation2;

    }

    /**
     * Collect all lights from the scene (D3D-style, up to 8 lights)
     * Returns light data arrays for shader uniforms
     */
    collectSceneLights() {

        const result = this._lightData;
        result.count = 0;

        if ( ! this.maxScene.group ) return result;

        // Collect lights from the scene (like D3D's SetLight/LightEnable)
        for ( const child of this._sceneLights ) {

            if ( result.count >= MAX_LIGHTS ) break;

            if ( child.isPointLight || child.isSpotLight || child.isDirectionalLight ) {

                const i = result.count;
                const lightData = child.userData.lightData;

                // Get world position
                child.getWorldPosition( result.positions[ i ] );

                // Get direction (for directional/spot lights)
                if ( child.isDirectionalLight || child.isSpotLight ) {

                    // Use original direction from 3px light data
                    if ( lightData && lightData.direction ) {

                        result.directions[ i ].set(
                            lightData.direction.x,
                            lightData.direction.y,
                            lightData.direction.z
                        );

                    } else if ( child.isSpotLight && child.target ) {

                        // Fallback: spot light direction toward target
                        result.directions[ i ].subVectors( child.target.position, child.position ).normalize();

                    }

                }

                // Light type: 1=point, 2=spot, 3=directional (D3D convention)
                let lightType = 1;

                if ( child.isDirectionalLight ) lightType = 3;
                else if ( child.isSpotLight ) lightType = 2;

                // Preserve the separate fixed-function diffuse and specular colors.
                if ( lightData && lightData.diffuse ) {

                    result.diffuseColors[ i ].set(
                        lightData.diffuse.r,
                        lightData.diffuse.g,
                        lightData.diffuse.b
                    );

                } else {

                    result.diffuseColors[ i ].set( child.color.r, child.color.g, child.color.b );

                }

                if ( lightData && lightData.specular ) {

                    result.specularColors[ i ].set(
                        lightData.specular.r,
                        lightData.specular.g,
                        lightData.specular.b
                    );

                } else {

                    result.specularColors[ i ].copy( result.diffuseColors[ i ] );

                }

                // Light parameters: [type, range, attenuation0, attenuation1]
                const range = lightData ? lightData.range : ( child.distance || 0 );
                const atten0 = lightData && lightData.attenuation ? lightData.attenuation[ 0 ] : 1;
                const atten1 = lightData && lightData.attenuation ? lightData.attenuation[ 1 ] : 0;
                const atten2 = lightData && lightData.attenuation ? lightData.attenuation[ 2 ] : 0;

                result.params[ i ].set( lightType, range, atten0, atten1 );
                result.attenuation2[ i ] = atten2;

                result.count ++;

            }

        }

        return result;

    }

}
