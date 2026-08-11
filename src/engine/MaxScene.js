import * as THREE from 'three';
import { KeyFrameSequence } from './KeyFrameSequence.js';
import { ScalarSequence } from './ScalarSequence.js';

const SCENE_ASPECT = 4 / 3;
const CAMERA_ROTATION = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3( 1, 0, 0 ),
    Math.PI / 2
);

/**
 * MaxScene - Manages a 3PX scene with animation playback
 */
export class MaxScene {

    constructor() {

        this.group = new THREE.Group();
        this.meshes = [];
        this.meshMap = new Map();
        this.cameras = [];
        this.cameraMap = new Map();
        this.lights = [];
        this.lightObjects = [];

        this.activeCamera = null;
        this.activeCameraData = null;
        this.activeCameraName = null;
        this.initialCameraName = null;

        this.fogEnabled = false;
        this._fog = new THREE.Fog( 0x000000, 0, 1000 );

        // Noise shake effect
        this.noiseX = 0;
        this.noiseY = 0;
        this.noiseZ = 0;
        this.noiseStartTime = 0;
        this.noiseDuration = 0;

        // Per-frame scratch objects
        this._position = new THREE.Vector3();
        this._quaternion = new THREE.Quaternion();
        this._cameraQuaternion = new THREE.Quaternion();
        this._noiseRight = new THREE.Vector3();
        this._noiseUp = new THREE.Vector3();
        this._noiseForward = new THREE.Vector3();
        this._noiseOffset = new THREE.Vector3();

    }

    /**
     * Load scene data from Loader3PX output
     */
    load( sceneData ) {

        this.group = sceneData.group;
        this.meshes = sceneData.meshes;
        this.meshMap = sceneData.meshMap;
        this.cameras = sceneData.cameras;
        this.cameraMap = sceneData.cameraMap;
        this.lights = sceneData.lights;
        this.lightObjects = new Array( this.lights.length );
        this.group.traverse( object => {

            if ( object.isLight && object.userData.index !== undefined ) {

                this.lightObjects[ object.userData.index ] = object;

            }

        } );
        // Wrap raw animation data in sequence classes
        for ( const mesh of this.meshes ) {

            if ( mesh.keyFrameSequence ) {

                mesh._kfSeq = new KeyFrameSequence( mesh.keyFrameSequence );

            }

        }

        for ( const camera of this.cameras ) {

            if ( camera.keyFrameSequence ) {

                camera._kfSeq = new KeyFrameSequence( camera.keyFrameSequence );

            }

            if ( camera.scalarSequence ) {

                camera._scalarSeq = new ScalarSequence( camera.scalarSequence );

            }

        }

        for ( const light of this.lights ) {

            if ( light.keyFrameSequence ) {

                light._kfSeq = new KeyFrameSequence( light.keyFrameSequence );

            }

        }

        // Set first camera as active if available
        if ( this.cameras.length > 0 ) {

            this.initialCameraName = this.cameras[ 0 ].name;
            this.setCamera( this.initialCameraName );

        }

    }

    /**
     * Set the active camera by name
     */
    setCamera( name ) {

        const camera = this.cameraMap.get( name );

        if ( camera ) {

            this.activeCamera = camera;
            this.activeCameraData = this.cameras.find( candidate => candidate.name === name ) || null;
            this.activeCameraName = name;

        } else {

            console.warn( `MaxScene: Camera "${name}" not found` );

        }

        return camera;

    }

    /**
     * Set animation start time
     */
    setAnimationOffset( time ) {

        // Update all animation sequences
        for ( const mesh of this.meshes ) {

            if ( mesh._kfSeq ) {

                mesh._kfSeq.setStartTime( time );

            }

        }

        for ( const camera of this.cameras ) {

            if ( camera._kfSeq ) {

                camera._kfSeq.setStartTime( time );

            }

            if ( camera._scalarSeq ) {

                camera._scalarSeq.setStartTime( time );

            }

        }

        for ( const light of this.lights ) {

            if ( light._kfSeq ) {

                light._kfSeq.setStartTime( time );

            }

        }

    }

    /**
     * Update scene animation
     */
    update( time ) {

        // Update mesh animations
        for ( const meshData of this.meshes ) {

            if ( meshData._kfSeq ) {

                const mesh = this.meshMap.get( meshData );

                if ( mesh ) {

                    meshData._kfSeq.getKeyFrame( time, this._position, this._quaternion );
                    mesh.position.copy( this._position );
                    mesh.quaternion.copy( this._quaternion );

                }

            }

        }

        // Update camera animation
        if ( this.activeCameraData && this.activeCamera ) {

            if ( this.activeCameraData._kfSeq ) {

                this.activeCameraData._kfSeq.getKeyFrame( time, this._position, this._quaternion );
                this.activeCamera.position.copy( this._position );

                // Apply +90° X rotation exactly as C++ does:
                // KeyFrameFinal.m_Rotation = KeyFrameFinal.m_Rotation * Quaternion(0.5f*PI, X_AXIS)
                // Quaternion is already converted to OpenGL coordinates at parse time.
                this._cameraQuaternion.copy( this._quaternion ).multiply( CAMERA_ROTATION );
                this.activeCamera.quaternion.copy( this._cameraQuaternion );

            }

            // Convert horizontal FOV to vertical for Three.js
            if ( this.activeCameraData._scalarSeq ) {

                const hFov = this.activeCameraData._scalarSeq.getValue( time );
                const hFovRad = hFov * Math.PI / 180;
                const vFovRad = 2 * Math.atan( Math.tan( hFovRad / 2 ) / SCENE_ASPECT );
                const vFov = vFovRad * 180 / Math.PI;

                if ( this.activeCamera.fov !== vFov ) {

                    this.activeCamera.fov = vFov;
                    this.activeCamera.updateProjectionMatrix();

                }

            }

        }

        // Apply camera shake noise in camera-local space
        if ( this.noiseDuration > 0 ) {

            const elapsed = time - this.noiseStartTime;

            if ( elapsed < this.noiseDuration && this.activeCamera ) {

                const factor = 1 - elapsed / this.noiseDuration;

                this._noiseRight.set( 1, 0, 0 ).applyQuaternion( this.activeCamera.quaternion );
                this._noiseUp.set( 0, 1, 0 ).applyQuaternion( this.activeCamera.quaternion );
                this._noiseForward.set( 0, 0, - 1 ).applyQuaternion( this.activeCamera.quaternion );

                this._noiseOffset.set( 0, 0, 0 );
                this._noiseOffset.addScaledVector( this._noiseRight, ( Math.random() - 0.5 ) * this.noiseX * factor );
                this._noiseOffset.addScaledVector( this._noiseUp, ( Math.random() - 0.5 ) * this.noiseY * factor );
                this._noiseOffset.addScaledVector( this._noiseForward, ( Math.random() - 0.5 ) * this.noiseZ * factor );
                this.activeCamera.position.add( this._noiseOffset );

            }

        }

        // Update light animations
        for ( let i = 0; i < this.lights.length; i ++ ) {

            const lightData = this.lights[ i ];

            if ( lightData._kfSeq ) {

                lightData._kfSeq.getKeyFrame( time, this._position, this._quaternion );

                const light = this.lightObjects[ i ];

                if ( light ) {

                    // Position is already converted to OpenGL coordinates at parse time
                    light.position.copy( this._position );

                }

            }

        }

    }

    resetPlaybackState() {

        if ( this.initialCameraName ) this.setCamera( this.initialCameraName );
        this.fogEnabled = false;
        this.noiseDuration = 0;

    }

    /**
     * Set fog parameters
     */
    setFog( enabled, near, far, color ) {

        this.fogEnabled = enabled;

        if ( color !== undefined ) {

            this._fog.color.set( color );

        }

        this._fog.near = near;
        this._fog.far = far;

    }

    /**
     * Apply fog to a Three.js scene
     */
    applyFog( scene ) {

        if ( this.fogEnabled ) {

            scene.fog = this._fog;

        } else {

            scene.fog = null;

        }

    }

    /**
     * Set noise shake effect
     */
    setNoise( x, y, z, startTime, duration ) {

        this.noiseX = x;
        this.noiseY = y;
        this.noiseZ = z;
        this.noiseStartTime = startTime;
        this.noiseDuration = duration;

    }

    /**
     * Dispose of all resources
     */
    dispose() {

        const geometries = new Set();
        const materials = new Set();

        this.group.traverse( child => {

            if ( child.geometry ) geometries.add( child.geometry );

            if ( child.material ) {

                if ( Array.isArray( child.material ) ) {

                    child.material.forEach( material => materials.add( material ) );

                } else {

                    materials.add( child.material );

                }

            }

        } );

        geometries.forEach( geometry => geometry.dispose() );
        materials.forEach( material => material.dispose() );

        this.meshes = [];
        this.meshMap.clear();
        this.cameras = [];
        this.cameraMap.clear();
        this.lights = [];
        this.lightObjects = [];
        this.activeCamera = null;
        this.activeCameraData = null;
        this.activeCameraName = null;
        this.initialCameraName = null;

    }

}
