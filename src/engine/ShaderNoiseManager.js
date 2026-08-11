/**
 * ShaderNoiseManager - Singleton to manage shader noise effects
 * Tracks which shaders have NOISE effect and their parameters
 */
class ShaderNoiseManager {

    constructor() {

        this.noiseShaders = new Map(); // shaderName -> NoiseParams

    }

    setNoise( shaderName, fadeIn, duration, startTime, ampX, ampY, ampZ, spaceFreq, timeFreq ) {

        this.noiseShaders.set( shaderName.toLowerCase(), {
            fadeIn,
            duration,
            startTime,
            amplitudeX: ampX,
            amplitudeY: ampY,
            amplitudeZ: ampZ,
            spaceFrequency: spaceFreq,
            timeFrequency: timeFreq
        } );

    }

    getNoise( shaderName ) {

        return this.noiseShaders.get( shaderName.toLowerCase() );

    }

    getNoiseScale( shaderName, time ) {

        const params = this.getNoise( shaderName );
        if ( ! params ) return 0;

        // Final state: fadeIn=true stays at 1, fadeIn=false stays at 0
        // Matches C++ ExpSlider::GetValue behavior
        const finalState = params.fadeIn ? 1 : 0;

        // Duration of 0 means instant final state (no transition)
        if ( params.duration <= 0 ) return finalState;

        const elapsed = time - params.startTime;
        if ( elapsed >= params.duration ) return finalState;

        // During transition:
        // fadeIn=true: effect fades IN from 0 to 1
        // fadeIn=false: effect fades OUT from 1 to 0
        const t = elapsed / params.duration;
        return params.fadeIn ? t : ( 1 - t );

    }

    clearNoise( shaderName ) {

        this.noiseShaders.delete( shaderName.toLowerCase() );

    }

    clear() {

        this.noiseShaders.clear();

    }

}

export const shaderNoiseManager = new ShaderNoiseManager();
