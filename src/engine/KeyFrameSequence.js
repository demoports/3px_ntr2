import * as THREE from 'three';

/**
 * KeyFrameSequence - Interpolates position and rotation keyframes
 */
export class KeyFrameSequence {

    constructor( data ) {

        this.samplingRate = data?.samplingRate || 30;
        this.keyFrames = data?.keyFrames || [];
        this.startTime = 0;

        this._quatA = new THREE.Quaternion();
        this._quatB = new THREE.Quaternion();

    }

    get duration() {

        if ( this.keyFrames.length <= 1 ) return 0;
        return ( this.keyFrames.length - 1 ) / this.samplingRate;

    }

    setStartTime( time ) {

        this.startTime = time;

    }

    /**
     * Get interpolated position and rotation at a given time
     * @param {number} time - Current time in seconds
     * @param {THREE.Vector3} position - Output position
     * @param {THREE.Quaternion} quaternion - Output quaternion
     */
    getKeyFrame( time, position, quaternion ) {

        if ( this.keyFrames.length === 0 ) return;

        if ( this.keyFrames.length === 1 ) {

            const kf = this.keyFrames[ 0 ];
            position.set( kf.position.x, kf.position.y, kf.position.z );
            quaternion.set( kf.rotation.x, kf.rotation.y, kf.rotation.z, kf.rotation.w );
            return;

        }

        const localTime = time - this.startTime;

        // Clamp to non-negative time (animation doesn't play before start)
        const frame = Math.max( 0, localTime * this.samplingRate );

        // Get frame indices with wrapping
        const maxFrame = this.keyFrames.length - 1;
        const frameFloor = Math.floor( frame );
        let frameA = frameFloor % maxFrame;
        let frameB = frameA + 1;

        // Ensure valid indices
        frameA = Math.max( 0, Math.min( frameA, maxFrame ) );
        frameB = Math.max( 0, Math.min( frameB, this.keyFrames.length - 1 ) );

        // Interpolation factor
        const t = frame - frameFloor;

        const kfA = this.keyFrames[ frameA ];
        const kfB = this.keyFrames[ frameB ];

        // Linear interpolation for position
        position.set(
            kfA.position.x + ( kfB.position.x - kfA.position.x ) * t,
            kfA.position.y + ( kfB.position.y - kfA.position.y ) * t,
            kfA.position.z + ( kfB.position.z - kfA.position.z ) * t
        );

        // Spherical linear interpolation for rotation
        this._quatA.set( kfA.rotation.x, kfA.rotation.y, kfA.rotation.z, kfA.rotation.w );
        this._quatB.set( kfB.rotation.x, kfB.rotation.y, kfB.rotation.z, kfB.rotation.w );
        quaternion.copy( this._quatA ).slerp( this._quatB, t );

    }

}
