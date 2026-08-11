/**
 * ScalarSequence - Interpolates scalar values (e.g., FOV)
 */
export class ScalarSequence {

    constructor( data ) {

        this.samplingRate = data?.samplingRate || 30;
        this.values = data?.values || [];
        this.startTime = 0;

    }

    get duration() {

        if ( this.values.length <= 1 ) return 0;
        return ( this.values.length - 1 ) / this.samplingRate;

    }

    setStartTime( time ) {

        this.startTime = time;

    }

    /**
     * Get interpolated scalar value at a given time
     * @param {number} time - Current time in seconds
     * @returns {number} Interpolated value
     */
    getValue( time ) {

        if ( this.values.length === 0 ) return 0;

        if ( this.values.length === 1 ) return this.values[ 0 ];

        const localTime = time - this.startTime;

        // Clamp to non-negative time (animation doesn't play before start)
        const frame = Math.max( 0, localTime * this.samplingRate );

        // Get frame indices with wrapping (ScalarSequence wraps at full length per C++ code)
        const frameFloor = Math.floor( frame );
        const frameA = frameFloor % this.values.length;
        const frameB = ( frameA + 1 ) % this.values.length;

        // Interpolation factor
        const t = frame - frameFloor;

        // Linear interpolation
        return this.values[ frameA ] * ( 1 - t ) + this.values[ frameB ] * t;

    }

}
