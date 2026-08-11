import * as THREE from 'three';
import { BinaryReader } from './BinaryReader.js';

const SCENE_ASPECT = 4 / 3;
const CAMERA_ROTATION = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3( 1, 0, 0 ),
    Math.PI / 2
);

/**
 * Loader3PX - Loads .3px binary scene files
 *
 * Supported versions:
 * - Version 2 (Black Matters, 2001): Uncompressed vertices, no mesh names/hierarchy
 * - Version 3-6 (Nature v2, 2001): Compressed vertices, mesh hierarchy
 * - Version 7 (r08028, 2002): Same as v6 with 1-byte padding after UVs
 */
export class Loader3PX {

    constructor() {

        this.version = 0;

    }

    /**
     * Parse a .3px binary buffer
     * @param {ArrayBuffer} buffer - The binary data
     * @returns {Object} Parsed scene data
     */
    parse( buffer ) {

        const reader = new BinaryReader( buffer );
        this.version = reader.readInt32();

        if ( this.version < 2 || this.version > 7 ) {

            console.warn( `Loader3PX: Unexpected version ${this.version}, expected 2-7` );

        }

        if ( this.version === 2 ) {

            return this.parseV2( reader );

        } else {

            return this.parseV6( reader );

        }

    }

    // ========================================
    // Version 2 Parser (Black Matters format)
    // ========================================

    parseV2( reader ) {

        // Parse meshes (geometry only, no transforms yet)
        const numMeshes = reader.readUint32();
        const meshes = [];

        for ( let i = 0; i < numMeshes; i ++ ) {

            meshes.push( this.parseMeshV2( reader ) );

        }

        // Read mesh transforms: position (x,y,z) then quaternion (w,x,y,z)
        for ( let i = 0; i < numMeshes; i ++ ) {

            const px = reader.readFloat32();
            const py = reader.readFloat32();
            const pz = reader.readFloat32();
            const qw = reader.readFloat32();
            const qx = reader.readFloat32();
            const qy = reader.readFloat32();
            const qz = reader.readFloat32();

            // Convert from DirectX to OpenGL coordinates
            meshes[ i ].position = { x: px, y: py, z: - pz };
            meshes[ i ].rotation = { x: - qx, y: - qy, z: qz, w: qw };

        }

        // Read lights
        const numLights = reader.readUint32();
        const lights = [];

        for ( let i = 0; i < numLights; i ++ ) {

            lights.push( this.parseLight( reader ) );

        }

        // Read cameras
        const numCameras = reader.readUint32();
        const cameras = [];

        for ( let i = 0; i < numCameras; i ++ ) {

            cameras.push( this.parseCameraV2( reader ) );

        }

        // Read keyframe sequences
        const numKeyFrameSequences = reader.readUint32();
        const keyFrameSequences = [];

        for ( let i = 0; i < numKeyFrameSequences; i ++ ) {

            keyFrameSequences.push( this.parseKeyFrameSequence( reader, true ) );

        }

        // Assign keyframe sequences to objects
        this.assignKeyFrameSequences( reader, numKeyFrameSequences, keyFrameSequences, meshes, cameras, lights );

        // Parse scalar sequences (FOV animation)
        const scalarSequences = [];
        const numScalarSequences = reader.readUint32();

        for ( let i = 0; i < numScalarSequences; i ++ ) {

            scalarSequences.push( this.parseScalarSequence( reader ) );

        }

        // Assign scalar sequences (FOV animation for cameras)
        this.assignScalarSequences( reader, numScalarSequences, scalarSequences, cameras );

        return {
            version: 2,
            meshes,
            lights,
            cameras,
            keyFrameSequences,
            scalarSequences
        };

    }

    parseMeshV2( reader ) {

        // Version 2 has no mesh name
        const numElements = reader.readUint32();
        const elements = [];

        for ( let i = 0; i < numElements; i ++ ) {

            elements.push( this.parseMeshElementV2( reader ) );

        }

        return {
            name: '',
            elements,
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            pivotPosition: { x: 0, y: 0, z: 0 },
            pivotRotation: { x: 0, y: 0, z: 0, w: 1 },
            parentIndex: - 1,
            visible: true,
            keyFrameSequence: null
        };

    }

    /**
     * Parse uncompressed mesh element (version 2)
     * RenderVertex: x,y,z,nx,ny,nz (6 floats), diffuse,specular (2 uint32), u,v,s,t (4 floats) = 48 bytes
     */
    parseMeshElementV2( reader ) {

        const numVertices = reader.readUint32();
        const numIndices = reader.readUint32();

        const positions = new Float32Array( numVertices * 3 );
        const normals = new Float32Array( numVertices * 3 );
        const colors = new Float32Array( numVertices * 4 );
        const uvs = new Float32Array( numVertices * 2 );

        for ( let i = 0; i < numVertices; i ++ ) {

            // Position (3 floats)
            positions[ i * 3 + 0 ] = reader.readFloat32();
            positions[ i * 3 + 1 ] = reader.readFloat32();
            positions[ i * 3 + 2 ] = - reader.readFloat32(); // Negate Z

            // Normal (3 floats)
            normals[ i * 3 + 0 ] = reader.readFloat32();
            normals[ i * 3 + 1 ] = reader.readFloat32();
            normals[ i * 3 + 2 ] = - reader.readFloat32(); // Negate Z

            // Diffuse color (ARGB uint32)
            const diffuse = reader.readColorARGB();
            colors[ i * 4 + 0 ] = diffuse.r / 255.0;
            colors[ i * 4 + 1 ] = diffuse.g / 255.0;
            colors[ i * 4 + 2 ] = diffuse.b / 255.0;
            colors[ i * 4 + 3 ] = diffuse.a / 255.0;

            // Specular (skip)
            reader.skip( 4 );

            // UV (2 floats)
            uvs[ i * 2 + 0 ] = reader.readFloat32();
            uvs[ i * 2 + 1 ] = 1.0 - reader.readFloat32(); // Flip V

            // Skip s,t (2 floats)
            reader.skip( 8 );

        }

        // Indices (always uint16 in uncompressed format)
        const indices = reader.readUint16Array( numIndices );

        // Material name (fixed 128-byte buffer)
        const materialName = reader.readString( 128 );

        return { positions, normals, colors, uvs, indices, materialName };

    }

    parseCameraV2( reader ) {

        const position = reader.readVector3GL();
        const rotation = reader.readQuaternionGL();
        const fov = reader.readFloat32();
        const near = reader.readFloat32();
        const far = reader.readFloat32();
        const name = reader.readString( 256 );

        return {
            position,
            rotation,
            fov,
            near,
            far,
            name: name.trim(),
            keyFrameSequence: null,
            scalarSequence: null
        };

    }

    // ========================================
    // Version 3-7 Parser (Compressed format)
    // ========================================

    parseV6( reader ) {

        const numMeshes = reader.readUint32();
        const meshes = [];

        for ( let i = 0; i < numMeshes; i ++ ) {

            meshes.push( this.parseMeshV6( reader ) );

        }

        // Parse lights
        const numLights = reader.readUint32();
        const lights = [];

        for ( let i = 0; i < numLights; i ++ ) {

            lights.push( this.parseLight( reader ) );

        }

        // Parse cameras
        const numCameras = reader.readUint32();
        const cameras = [];

        for ( let i = 0; i < numCameras; i ++ ) {

            cameras.push( this.parseCameraV6( reader ) );

        }

        // Parse keyframe sequences
        const numKeyFrameSequences = reader.readUint32();
        const keyFrameSequences = [];

        for ( let i = 0; i < numKeyFrameSequences; i ++ ) {

            keyFrameSequences.push( this.parseKeyFrameSequence( reader, this.version < 6 ) );

        }

        // Assign keyframe sequences to objects
        this.assignKeyFrameSequences( reader, numKeyFrameSequences, keyFrameSequences, meshes, cameras, lights );

        // Parse scalar sequences (FOV animation)
        const scalarSequences = [];
        const numScalarSequences = reader.readUint32();

        for ( let i = 0; i < numScalarSequences; i ++ ) {

            scalarSequences.push( this.parseScalarSequence( reader ) );

        }

        // Assign scalar sequences (FOV animation for cameras)
        this.assignScalarSequences( reader, numScalarSequences, scalarSequences, cameras );

        return {
            version: this.version,
            meshes,
            lights,
            cameras,
            keyFrameSequences,
            scalarSequences
        };

    }

    parseMeshV6( reader ) {

        const name = reader.readLengthPrefixedString();
        const numElements = reader.readUint32();
        const elements = [];

        for ( let i = 0; i < numElements; i ++ ) {

            elements.push( this.parseMeshElementV6( reader ) );

        }

        // Initial keyframe (position + rotation)
        const keyFrame = this.parseKeyFrame( reader );

        // Pivot keyframe
        const pivotKeyFrame = this.parseKeyFrame( reader );

        // Parent index (-1 = root)
        const parentIndex = reader.readInt32();

        return {
            name: name.toUpperCase(),
            elements,
            position: keyFrame.position,
            rotation: keyFrame.rotation,
            pivotPosition: pivotKeyFrame.position,
            pivotRotation: pivotKeyFrame.rotation,
            parentIndex,
            visible: ! name.startsWith( '*' ),
            keyFrameSequence: null
        };

    }

    /**
     * Parse compressed mesh element (version 3-7)
     */
    parseMeshElementV6( reader ) {

        const numVertices = reader.readUint32();
        const numIndices = reader.readUint32();

        // Positions - quantized to 16-bit with bounding box
        const posMin = reader.readVector3();
        const posMax = reader.readVector3();
        const posData = reader.readUint16Array( numVertices * 3 );

        const positions = new Float32Array( numVertices * 3 );
        const posDiff = {
            x: posMax.x - posMin.x,
            y: posMax.y - posMin.y,
            z: posMax.z - posMin.z
        };

        for ( let i = 0; i < numVertices; i ++ ) {

            positions[ i * 3 + 0 ] = posMin.x + posDiff.x * posData[ i * 3 + 0 ] / 65535.0;
            positions[ i * 3 + 1 ] = posMin.y + posDiff.y * posData[ i * 3 + 1 ] / 65535.0;
            positions[ i * 3 + 2 ] = - ( posMin.z + posDiff.z * posData[ i * 3 + 2 ] / 65535.0 ); // Negate Z

        }

        // Normals - 8-bit per component
        const normalData = reader.readUint8Array( numVertices * 3 );
        const normals = new Float32Array( numVertices * 3 );

        for ( let i = 0; i < numVertices; i ++ ) {

            let nx = 2.0 * normalData[ i * 3 + 0 ] / 255.0 - 1.0;
            let ny = 2.0 * normalData[ i * 3 + 1 ] / 255.0 - 1.0;
            let nz = 2.0 * normalData[ i * 3 + 2 ] / 255.0 - 1.0;

            const len = Math.sqrt( nx * nx + ny * ny + nz * nz );

            if ( len > 0 ) {

                nx /= len;
                ny /= len;
                nz /= len;

            }

            normals[ i * 3 + 0 ] = nx;
            normals[ i * 3 + 1 ] = ny;
            normals[ i * 3 + 2 ] = - nz; // Negate Z

        }

        // Vertex colors - ARGB uint32
        const colors = new Float32Array( numVertices * 4 );

        for ( let i = 0; i < numVertices; i ++ ) {

            const color = reader.readColorARGB();
            colors[ i * 4 + 0 ] = color.r / 255.0;
            colors[ i * 4 + 1 ] = color.g / 255.0;
            colors[ i * 4 + 2 ] = color.b / 255.0;
            colors[ i * 4 + 3 ] = color.a / 255.0;

        }

        // UVs - quantized to 16-bit with bounding box
        const uvMinU = reader.readFloat32();
        const uvMinV = reader.readFloat32();
        const uvMaxU = reader.readFloat32();
        const uvMaxV = reader.readFloat32();
        const uvData = reader.readUint16Array( numVertices * 2 );

        const uvs = new Float32Array( numVertices * 2 );
        const uvDiffU = uvMaxU - uvMinU;
        const uvDiffV = uvMaxV - uvMinV;

        for ( let i = 0; i < numVertices; i ++ ) {

            uvs[ i * 2 + 0 ] = uvMinU + uvDiffU * uvData[ i * 2 + 0 ] / 65535.0;
            uvs[ i * 2 + 1 ] = 1.0 - ( uvMinV + uvDiffV * uvData[ i * 2 + 1 ] / 65535.0 ); // Flip V

        }

        // Version 7: 1 byte padding after UV data
        if ( this.version >= 7 ) {

            reader.skip( 1 );

        }

        // Material name
        const materialName = reader.readLengthPrefixedString();

        // Indices - 8-bit if numVertices <= 255, else 16-bit
        let indices;

        if ( numVertices > 255 ) {

            indices = reader.readUint16Array( numIndices );

        } else {

            const indexData = reader.readUint8Array( numIndices );
            indices = new Uint16Array( numIndices );

            for ( let i = 0; i < numIndices; i ++ ) {

                indices[ i ] = indexData[ i ];

            }

        }

        return { positions, normals, colors, uvs, indices, materialName };

    }

    parseCameraV6( reader ) {

        const keyFrame = this.parseKeyFrame( reader );
        const fov = reader.readFloat32();
        const near = reader.readFloat32();
        const far = reader.readFloat32();
        const name = reader.readString( 256 );

        return {
            position: keyFrame.position,
            rotation: keyFrame.rotation,
            fov,
            near,
            far,
            name: name.trim(),
            keyFrameSequence: null,
            scalarSequence: null
        };

    }

    // ========================================
    // Shared Parsers
    // ========================================

    parseKeyFrame( reader ) {

        return {
            position: reader.readVector3GL(),
            rotation: reader.readQuaternionGL()
        };

    }

    parseKeyFrameSequence( reader, intSamplingRate ) {

        const numKeyFrames = reader.readUint32();
        const samplingRate = intSamplingRate ? reader.readUint32() : reader.readFloat32();

        const keyFrames = [];

        for ( let i = 0; i < numKeyFrames; i ++ ) {

            keyFrames.push( this.parseKeyFrame( reader ) );

        }

        return { samplingRate, keyFrames };

    }

    parseScalarSequence( reader ) {

        const numScalars = reader.readUint32();
        const samplingRate = reader.readUint32();
        const values = reader.readFloat32Array( numScalars );

        return {
            samplingRate,
            values: Array.from( values )
        };

    }

    parseLight( reader ) {

        const type = reader.readInt32();

        const diffuse = {
            r: reader.readFloat32(),
            g: reader.readFloat32(),
            b: reader.readFloat32(),
            a: reader.readFloat32()
        };

        const specular = {
            r: reader.readFloat32(),
            g: reader.readFloat32(),
            b: reader.readFloat32(),
            a: reader.readFloat32()
        };

        const ambient = {
            r: reader.readFloat32(),
            g: reader.readFloat32(),
            b: reader.readFloat32(),
            a: reader.readFloat32()
        };

        const position = reader.readVector3GL();
        const direction = reader.readVector3GL();

        const range = reader.readFloat32();
        const falloff = reader.readFloat32();
        const attenuation0 = reader.readFloat32();
        const attenuation1 = reader.readFloat32();
        const attenuation2 = reader.readFloat32();
        const theta = reader.readFloat32();
        const phi = reader.readFloat32();

        return {
            type,
            diffuse,
            specular,
            ambient,
            position,
            direction,
            range,
            falloff,
            attenuation0,
            attenuation1,
            attenuation2,
            theta,
            phi,
            keyFrameSequence: null
        };

    }

    assignKeyFrameSequences( reader, count, sequences, meshes, cameras, lights ) {

        for ( let i = 0; i < count; i ++ ) {

            const type = reader.readInt32(); // 0=mesh, 1=light, 2=camera
            const index = reader.readInt32();

            if ( index === - 1 ) continue;

            const seq = sequences[ i ];

            switch ( type ) {

                case 0: // E_MESH
                    if ( index < meshes.length ) meshes[ index ].keyFrameSequence = seq;
                    break;

                case 1: // E_LIGHT
                    if ( index < lights.length ) lights[ index ].keyFrameSequence = seq;
                    break;

                case 2: // E_CAMERA
                    if ( index < cameras.length ) cameras[ index ].keyFrameSequence = seq;
                    break;

            }

        }

    }

    assignScalarSequences( reader, count, sequences, cameras ) {

        for ( let i = 0; i < count; i ++ ) {

            const type = reader.readInt32();
            const index = reader.readInt32();

            if ( index === - 1 ) continue;

            if ( type === 2 && index < cameras.length ) {

                cameras[ index ].scalarSequence = sequences[ i ];

            }

        }

    }

    // ========================================
    // Scene Builder (shared across all versions)
    // ========================================

    buildScene( data ) {

        const group = new THREE.Group();
        const meshMap = new Map();
        const cameraMap = new Map();

        // Build meshes
        for ( const meshData of data.meshes ) {

            const mesh = this.buildMesh( meshData );
            meshMap.set( meshData, mesh );

            mesh.visible = meshData.visible;

        }

        // Recreate the exported MAX hierarchy. Three.js then composes each
        // animated local transform with its parent's world transform exactly as
        // D3DMesh::Render did in the original engine.
        for ( let i = 0; i < data.meshes.length; i ++ ) {

            const meshData = data.meshes[ i ];
            const mesh = meshMap.get( meshData );
            const parentData = data.meshes[ meshData.parentIndex ];
            const parent = parentData ? meshMap.get( parentData ) : null;

            if ( parent && parent !== mesh ) {

                parent.add( mesh );

            } else {

                group.add( mesh );

            }

        }

        // Build cameras
        for ( const camData of data.cameras ) {

            const camera = this.buildCamera( camData );
            cameraMap.set( camData.name, camera );

        }

        // Build lights
        for ( let i = 0; i < data.lights.length; i ++ ) {

            const lightData = data.lights[ i ];
            const light = this.buildLight( lightData );
            light.userData.index = i;
            group.add( light );

        }

        return {
            group,
            meshes: data.meshes,
            meshMap,
            cameras: data.cameras,
            cameraMap,
            lights: data.lights
        };

    }

    buildMesh( meshData ) {

        const group = new THREE.Group();
        group.name = meshData.name;

        for ( const element of meshData.elements ) {

            const geometry = new THREE.BufferGeometry();

            geometry.setAttribute( 'position', new THREE.BufferAttribute( element.positions, 3 ) );
            geometry.setAttribute( 'normal', new THREE.BufferAttribute( element.normals, 3 ) );
            geometry.setAttribute( 'uv', new THREE.BufferAttribute( element.uvs, 2 ) );
            geometry.setAttribute( 'color', new THREE.BufferAttribute( element.colors, 4 ) );
            geometry.setIndex( new THREE.BufferAttribute( element.indices, 1 ) );

            const material = new THREE.MeshBasicMaterial( {
                side: THREE.DoubleSide,
                transparent: true,
                fog: true
            } );
            material.userData.materialName = element.materialName;

            const mesh = new THREE.Mesh( geometry, material );
            group.add( mesh );

        }

        group.position.set( meshData.position.x, meshData.position.y, meshData.position.z );
        group.quaternion.set( meshData.rotation.x, meshData.rotation.y, meshData.rotation.z, meshData.rotation.w );

        return group;

    }

    buildCamera( camData ) {

        // Convert horizontal FOV to vertical for Three.js
        const hFovRad = camData.fov * Math.PI / 180;
        const vFovRad = 2 * Math.atan( Math.tan( hFovRad / 2 ) / SCENE_ASPECT );
        const fovDegrees = vFovRad * 180 / Math.PI;

        const camera = new THREE.PerspectiveCamera(
            fovDegrees,
            SCENE_ASPECT,
            camData.near || 0.1,
            camData.far || 10000
        );

        camera.name = camData.name;

        camera.position.set(
            camData.position.x,
            camData.position.y,
            camData.position.z
        );

        // Apply camera rotation with +90° X rotation (as C++ does)
        const q = new THREE.Quaternion(
            camData.rotation.x,
            camData.rotation.y,
            camData.rotation.z,
            camData.rotation.w
        );

        q.multiply( CAMERA_ROTATION );

        camera.quaternion.copy( q );

        // Flip camera to look in correct direction
        camera.scale.y = - 1;
        camera.scale.z = - 1;

        return camera;

    }

    buildLight( lightData ) {

        let light;

        // D3D8 D3DLIGHTTYPE: POINT=1, SPOT=2, DIRECTIONAL=3
        switch ( lightData.type ) {

            case 1:
                light = new THREE.PointLight(
                    new THREE.Color( lightData.diffuse.r, lightData.diffuse.g, lightData.diffuse.b ),
                    1,
                    lightData.range
                );
                break;

            case 2:
                light = new THREE.SpotLight(
                    new THREE.Color( lightData.diffuse.r, lightData.diffuse.g, lightData.diffuse.b ),
                    1,
                    lightData.range,
                    lightData.phi / 2,
                    lightData.falloff
                );
                break;

            case 3:
                light = new THREE.DirectionalLight(
                    new THREE.Color( lightData.diffuse.r, lightData.diffuse.g, lightData.diffuse.b ),
                    1
                );
                break;

            default:
                console.warn( `Loader3PX: Unknown light type ${lightData.type}, using PointLight` );
                light = new THREE.PointLight(
                    new THREE.Color( lightData.diffuse.r, lightData.diffuse.g, lightData.diffuse.b ),
                    1,
                    lightData.range
                );

        }

        light.position.set(
            lightData.position.x,
            lightData.position.y,
            lightData.position.z
        );

        // Store original 3px light data
        light.userData.lightData = {
            type: lightData.type,
            diffuse: lightData.diffuse,
            specular: lightData.specular,
            direction: lightData.direction,
            range: lightData.range,
            falloff: lightData.falloff,
            attenuation: [ lightData.attenuation0, lightData.attenuation1, lightData.attenuation2 ],
            theta: lightData.theta,
            phi: lightData.phi
        };

        return light;

    }

}
