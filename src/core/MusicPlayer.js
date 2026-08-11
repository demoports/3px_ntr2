/**
 * MusicPlayer - HTMLAudioElement wrapper for music playback
 */
export class MusicPlayer {

    constructor() {

        this.element = null;
        this.objectUrl = null;

        this.isPlaying = false;
        this.isPaused = false;
        this.isLooping = false;

        this.pauseTime = 0;
        this.duration = 0;

        this._loadGeneration = 0;
        this._cancelLoad = null;
        this._playGeneration = 0;
        this._onEnded = null;
        this._onError = null;

        this._handleEnded = this._handleEnded.bind( this );
        this._handleMediaError = this._handleMediaError.bind( this );

    }

    /**
     * Create the native audio element.
     */
    init() {

        if ( this.element ) return;

        this.element = new Audio();
        this.element.preload = 'auto';
        this.element.addEventListener( 'ended', this._handleEnded );
        this.element.addEventListener( 'error', this._handleMediaError );

    }

    /**
     * Load an audio file.
     * @param {string|ArrayBuffer} source - URL or ArrayBuffer of audio data
     * @returns {Promise<void>}
     */
    async load( source ) {

        this.init();
        const generation = ++ this._loadGeneration;
        this._cancelPendingLoad();
        this.stop();
        this._clearSource();

        let blob;

        if ( typeof source === 'string' ) {

            const response = await fetch( source );

            if ( ! response.ok ) {

                throw new Error( `Failed to load audio: ${response.status} ${response.statusText}` );

            }

            blob = await response.blob();

        } else {

            blob = new Blob( [ source ], { type: 'audio/mpeg' } );

        }

        if ( generation !== this._loadGeneration || ! this.element ) {

            throw new DOMException( 'Audio load was cancelled', 'AbortError' );

        }

        const audio = this.element;
        const objectUrl = URL.createObjectURL( blob );
        this.objectUrl = objectUrl;

        try {

            this.duration = await new Promise( ( resolve, reject ) => {

                let settled = false;

                const cleanup = () => {

                    audio.removeEventListener( 'canplay', ready );
                    audio.removeEventListener( 'durationchange', ready );
                    audio.removeEventListener( 'error', failed );

                };
                const settle = ( callback, value ) => {

                    if ( settled ) return;

                    settled = true;
                    cleanup();

                    if ( this._cancelLoad === cancel ) this._cancelLoad = null;

                    callback( value );

                };
                const ready = () => {

                    if ( generation !== this._loadGeneration || this.objectUrl !== objectUrl ) {

                        settle( reject, new DOMException( 'Audio load was cancelled', 'AbortError' ) );
                        return;

                    }

                    if ( audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA ||
                        ! Number.isFinite( audio.duration ) ) return;

                    settle( resolve, audio.duration );

                };
                const failed = () => {

                    settle( reject, new Error( 'Failed to load audio' ) );

                };
                const cancel = () => {

                    settle( reject, new DOMException( 'Audio load was cancelled', 'AbortError' ) );

                };

                this._cancelLoad = cancel;
                audio.addEventListener( 'canplay', ready );
                audio.addEventListener( 'durationchange', ready );
                audio.addEventListener( 'error', failed );
                audio.src = objectUrl;
                audio.load();

                ready();

            } );

        } catch ( error ) {

            if ( this.objectUrl === objectUrl ) this._clearSource();
            throw error;

        }

    }

    /**
     * Play the loaded audio.
     * @param {boolean} loop - Whether to loop the audio
     */
    play( loop = false ) {

        if ( ! this.element?.src ) {

            console.warn( 'MusicPlayer: No audio loaded' );
            return;

        }

        const wasPaused = this.isPaused;
        const offset = wasPaused ? this.pauseTime : 0;
        const generation = ++ this._playGeneration;

        this.element.pause();
        this.element.loop = loop;
        this.element.currentTime = this._clampTime( offset );

        this.isPlaying = true;
        this.isPaused = false;
        this.isLooping = loop;

        try {

            const playPromise = this.element.play();
            playPromise?.catch( error => this._handlePlayError( error, generation, offset, wasPaused ) );

        } catch ( error ) {

            this._handlePlayError( error, generation, offset, wasPaused );

        }

    }

    /**
     * Pause playback.
     */
    pause() {

        if ( ! this.isPlaying || this.isPaused ) return;

        this.pauseTime = this.getCurrentTime();
        this._playGeneration ++;
        this.element.pause();
        this.isPlaying = false;
        this.isPaused = true;

    }

    /**
     * Resume playback after pause.
     */
    resume() {

        if ( ! this.isPaused ) return;

        this.play( this.isLooping );

    }

    /**
     * Stop playback.
     */
    stop() {

        this._playGeneration ++;

        if ( this.element ) {

            this.element.pause();

            if ( this.element.src ) this.element.currentTime = 0;

        }

        this.isPlaying = false;
        this.isPaused = false;
        this.pauseTime = 0;

    }

    /**
     * Seek to a specific time.
     * @param {number} time - Time in seconds
     */
    seek( time ) {

        const targetTime = this._clampTime( time );
        this.pauseTime = targetTime;

        if ( this.element?.src ) this.element.currentTime = targetTime;

        if ( ! this.isPlaying ) this.isPaused = true;

    }

    /**
     * Get current playback time.
     * @returns {number} Time in seconds
     */
    getCurrentTime() {

        if ( this.isPaused ) return this.pauseTime;
        if ( ! this.isPlaying || ! this.element ) return 0;

        let time = this.element.currentTime;

        if ( this.isLooping && this.duration > 0 ) time %= this.duration;

        return time;

    }

    /**
     * Set playback volume.
     * @param {number} volume - Volume (0.0 - 1.0)
     */
    setVolume( volume ) {

        if ( this.element ) {

            this.element.volume = Math.max( 0, Math.min( volume, 1 ) );

        }

    }

    /**
     * Get playback volume.
     * @returns {number} Volume (0.0 - 1.0)
     */
    getVolume() {

        return this.element ? this.element.volume : 1;

    }

    /**
     * Set callback for when playback ends.
     * @param {Function|null} callback
     */
    onEnded( callback ) {

        this._onEnded = callback;

    }

    /**
     * Set callback for playback errors.
     * @param {Function|null} callback
     */
    onError( callback ) {

        this._onError = callback;

    }

    _clampTime( time ) {

        const lowerBound = Math.max( 0, Number.isFinite( time ) ? time : 0 );
        return this.duration > 0 ? Math.min( lowerBound, this.duration ) : lowerBound;

    }

    _handleEnded() {

        if ( ! this.isPlaying || this.isLooping ) return;

        this.isPlaying = false;
        this._onEnded?.();

    }

    _handleMediaError() {

        if ( ! this.isPlaying ) return;

        const error = new Error( `Media playback failed (code ${this.element.error?.code ?? 'unknown'})` );

        this._playGeneration ++;
        this.pauseTime = this.element.currentTime;
        this.isPlaying = false;
        this.isPaused = true;
        console.error( 'MusicPlayer: Playback failed', error );
        this._onError?.( error );

    }

    _handlePlayError( error, generation, offset, wasPaused ) {

        if ( generation !== this._playGeneration ) return;

        this.isPlaying = false;
        this.isPaused = wasPaused;
        this.pauseTime = offset;
        console.error( 'MusicPlayer: Playback failed', error );
        this._onError?.( error );

    }

    _cancelPendingLoad() {

        const cancel = this._cancelLoad;
        this._cancelLoad = null;
        cancel?.();

    }

    _clearSource() {

        if ( this.element ) {

            this.element.pause();
            this.element.removeAttribute( 'src' );
            this.element.load();

        }

        if ( this.objectUrl ) URL.revokeObjectURL( this.objectUrl );

        this.objectUrl = null;
        this.duration = 0;

    }

    /**
     * Dispose of resources.
     */
    dispose() {

        this._loadGeneration ++;
        this._cancelPendingLoad();
        this.stop();

        if ( this.element ) {

            this.element.removeEventListener( 'ended', this._handleEnded );
            this.element.removeEventListener( 'error', this._handleMediaError );
            this._clearSource();
            this.element = null;

        }

        this._onEnded = null;
        this._onError = null;

    }

}
