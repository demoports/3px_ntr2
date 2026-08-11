/**
 * DemoPlayer - Script parser and executor for the demo timeline
 */

const SEEK_COMMAND_OPTIONS = Object.freeze( {
    log: false,
    audio: false,
    lifecycle: false
} );

function nowSeconds() {

    return performance.now() / 1000;

}

export class DemoPlayer {

    constructor() {

        this.commands = [];
        this.currentCommandIndex = 0;
        this.effects = new Map();
        this.activeEffects = [];

        this.musicPlayer = null;
        this.currentTime = 0;
        this.startTime = 0;
        this.isPlaying = false;
        this.isWaiting = false;
        this.waitStartTime = 0;
        this.waitDuration = 0;
        this.syncTargetTime = - 1;

    }

    /**
     * Register an effect instance
     */
    registerEffect( name, effect ) {

        this.effects.set( name.toUpperCase(), effect );
        effect.name = name;

    }

    /**
     * Set the music player
     */
    setMusicPlayer( musicPlayer ) {

        this.musicPlayer = musicPlayer;

    }

    /**
     * Load every resource declared in the script before playback starts.
     *
     * The original executable ran its loading section synchronously. Browser
     * image decoding and archive access are asynchronous, so allowing LOAD
     * commands to fall through the normal timeline creates a race with the
     * first FXSTART commands.
     */
    async preloadResources( onProgress = null ) {

        const loadCommands = this.commands.filter( command =>
            command.type === 'FXCOMMAND' && /^LOAD(?:\s|$)/i.test( command.args )
        );

        let completed = 0;

        for ( const command of loadCommands ) {

            const effect = this.effects.get( command.effect );

            if ( ! effect ) {

                throw new Error( `Effect not registered: ${command.effect}` );

            }

            const result = await effect.command( 0, command.args );

            if ( result !== 0 ) {

                throw new Error( `${command.effect} failed to execute ${command.args}` );

            }

            command.preloaded = true;
            completed ++;

            if ( onProgress ) onProgress( completed, loadCommands.length, command );

        }

    }

    /**
     * Parse a demo script
     * @param {string} scriptText - The script content
     */
    parse( scriptText ) {

        this.commands = [];
        this.currentCommandIndex = 0;

        const lines = scriptText.split( '\n' );

        for ( let i = 0; i < lines.length; i ++ ) {

            const line = lines[ i ].trim();

            // Skip empty lines
            if ( ! line ) continue;

            // Skip comments
            if ( line.startsWith( '//' ) ) continue;

            // Skip block comments [...]
            if ( line.startsWith( '[' ) ) {

                while ( i < lines.length && ! lines[ i ].includes( ']' ) ) {

                    i ++;

                }
                continue;

            }

            // Tokenize
            const tokens = this.tokenize( line );

            if ( tokens.length === 0 ) continue;

            const cmd = tokens[ 0 ].toUpperCase();

            try {

                const command = this.parseCommand( cmd, tokens.slice( 1 ) );

                if ( command ) {

                    this.commands.push( command );

                }

            } catch ( e ) {

                console.warn( `DemoPlayer: Error parsing line ${i + 1}: ${line}`, e );

            }

        }
    }

    /**
     * Tokenize a line of script
     */
    tokenize( line ) {

        const tokens = [];
        let current = '';
        let inQuotes = false;

        for ( let i = 0; i < line.length; i ++ ) {

            const char = line[ i ];

            if ( char === '"' ) {

                inQuotes = ! inQuotes;

            } else if ( ( char === ' ' || char === '\t' ) && ! inQuotes ) {

                if ( current ) {

                    tokens.push( current );
                    current = '';

                }

            } else {

                current += char;

            }

        }

        if ( current ) {

            tokens.push( current );

        }

        return tokens;

    }

    /**
     * Parse a single command
     */
    parseCommand( cmd, args ) {

        switch ( cmd ) {

            case 'FXLOAD':
                return { type: 'FXLOAD', effect: args[ 0 ]?.toUpperCase() };

            case 'FXSTART':
                return { type: 'FXSTART', effect: args[ 0 ]?.toUpperCase() };

            case 'FXSTOP':
                return { type: 'FXSTOP', effect: args[ 0 ]?.toUpperCase() };

            case 'FXSHUT':
                return { type: 'FXSHUT', effect: args[ 0 ]?.toUpperCase() };

            case 'FXCOMMAND':
                return {
                    type: 'FXCOMMAND',
                    effect: args[ 0 ]?.toUpperCase(),
                    args: args.slice( 1 ).join( ' ' )
                };

            case 'LOADMP3':
            case 'LOADTRACK':
            case 'LOADMUSIC':
                return {
                    type: 'LOADMP3',
                    name: args[ 0 ]?.toUpperCase(),
                    file: args[ 1 ]
                };

            case 'PLAYMUSIC':
            case 'PLAYMP3':
                return {
                    type: 'PLAYMUSIC',
                    name: args[ 0 ]?.toUpperCase(),
                    loop: args[ 1 ]?.toUpperCase() === 'LOOP'
                };

            case 'STOPMUSIC':
            case 'STOPMP3':
                return { type: 'STOPMUSIC' };

            case 'FREEMUSIC':
                return { type: 'FREEMUSIC', name: args[ 0 ]?.toUpperCase() };

            case 'SYNCTIME':
                return { type: 'SYNCTIME', time: parseFloat( args[ 0 ] ) };

            case 'WAIT':
                return { type: 'WAIT', time: parseFloat( args[ 0 ] ) };

            case 'SKIPTOTIME':
                return { type: 'SKIPTOTIME', time: parseFloat( args[ 0 ] ) };

            case 'SYNC':
                return {
                    type: 'SYNC',
                    pos: parseInt( args[ 0 ], 10 ),
                    row: parseInt( args[ 1 ], 10 )
                };

            case 'SKIPTO':
                return {
                    type: 'SKIPTO',
                    pos: parseInt( args[ 0 ], 10 ),
                    row: parseInt( args[ 1 ], 10 )
                };

            case 'VIDEOSTART':
            case 'VIDEOEND':
            case 'MEMBACKBUFFER':
            case 'VIDEOBACKBUFFER':
            case 'DUMP':
                // These commands are not relevant for the web port
                return null;

            default:
                console.warn( `DemoPlayer: Unknown command: ${cmd}` );
                return null;

        }

    }

    clearWaitState() {

        this.isWaiting = false;
        this.waitStartTime = 0;
        this.waitDuration = 0;
        this.syncTargetTime = - 1;

    }

    /**
     * Start the demo
     */
    start() {

        for ( const effect of this.effects.values() ) effect.resetPlaybackState?.();

        this.isPlaying = true;
        this.startTime = nowSeconds();
        this.currentTime = 0;
        this.currentCommandIndex = 0;
        this.clearWaitState();

    }

    /**
     * Rebuild the scripted state at an arbitrary music time.
     *
     * Moving only the audio clock leaves cameras, layers, fades, and active
     * effects at their old point in the timeline. Replaying from the beginning
     * with each command's authored time keeps both forward and backward seeks
     * deterministic without reloading any resources.
     */
    seek( targetTime ) {

        const target = Math.max( 0, Number.isFinite( targetTime ) ? targetTime : 0 );
        const now = nowSeconds();

        for ( const effect of this.effects.values() ) effect.stop();
        this.activeEffects.length = 0;

        for ( const effect of this.effects.values() ) effect.resetPlaybackState?.();

        this.currentTime = target;
        this.currentCommandIndex = 0;
        this.clearWaitState();
        this.isPlaying = true;

        let commandTime = 0;

        while ( this.currentCommandIndex < this.commands.length ) {

            const command = this.commands[ this.currentCommandIndex ];

            if ( command.type === 'SYNCTIME' ) {

                if ( target < command.time ) {

                    this.isWaiting = true;
                    this.syncTargetTime = command.time;
                    break;

                }

                commandTime = Math.max( commandTime, command.time );
                this.currentCommandIndex ++;
                continue;

            }

            if ( command.type === 'WAIT' ) {

                const duration = Math.max( 0, command.time || 0 );

                if ( target < commandTime + duration ) {

                    this.isWaiting = true;
                    this.waitStartTime = now - Math.max( 0, target - commandTime );
                    this.waitDuration = duration;
                    break;

                }

                commandTime += duration;
                this.currentCommandIndex ++;
                continue;

            }

            this.executeCommand( command, commandTime, SEEK_COMMAND_OPTIONS );
            this.currentCommandIndex ++;

        }

        this.currentTime = target;
        this.startTime = now - target;

        this.updateActiveEffects( target, 0 );

        return target;

    }

    updateActiveEffects( time, deltaTime ) {

        for ( let i = this.activeEffects.length - 1; i >= 0; i -- ) {

            const effect = this.activeEffects[ i ];

            if ( effect.update( time, deltaTime ) === false ) {

                effect.stop();
                this.activeEffects.splice( i, 1 );

            }

        }

    }

    /**
     * Stop the demo
     */
    stop() {

        this.isPlaying = false;

        // Stop all active effects
        for ( const effect of this.activeEffects ) {

            effect.stop();

        }

        this.activeEffects.length = 0;

        // Stop music
        if ( this.musicPlayer ) {

            this.musicPlayer.stop();

        }

    }

    /**
     * Update the demo - call each frame
     * @param {number} deltaTime - Time since last frame in seconds
     * @param {number} musicTime - Optional: current music time in seconds
     */
    update( deltaTime, musicTime ) {

        if ( ! this.isPlaying ) return;

        // Use provided music time, or get from music player, or calculate from start
        if ( musicTime !== undefined ) {

            this.currentTime = musicTime;

        } else if ( this.musicPlayer && this.musicPlayer.isPlaying ) {

            this.currentTime = this.musicPlayer.getCurrentTime();

        } else {

            this.currentTime = nowSeconds() - this.startTime;

        }

        // Process commands
        this.processCommands();

        this.updateActiveEffects( this.currentTime, deltaTime );

    }

    /**
     * Process pending commands
     */
    processCommands() {

        while ( this.currentCommandIndex < this.commands.length ) {

            // Handle waiting states
            if ( this.isWaiting ) {

                // SYNCTIME - wait for music time (use >= 0 to handle SYNCTIME 0)
                if ( this.syncTargetTime >= 0 ) {

                    if ( this.currentTime >= this.syncTargetTime ) {

                        this.isWaiting = false;
                        this.syncTargetTime = - 1;

                    } else {

                        return; // Still waiting

                    }

                }

                // WAIT - wait for duration
                if ( this.waitDuration > 0 ) {

                    const elapsed = nowSeconds() - this.waitStartTime;

                    if ( elapsed >= this.waitDuration ) {

                        this.clearWaitState();
                        this.currentCommandIndex ++;

                        if ( this.currentCommandIndex >= this.commands.length ) {

                            this.isPlaying = false;
                            return;

                        }

                        continue;

                    } else {

                        return; // Still waiting

                    }

                }

            }

            const command = this.commands[ this.currentCommandIndex ];

            if ( ! this.executeCommand( command ) ) {

                return; // Command blocked (waiting)

            }

            this.currentCommandIndex ++;

            if ( this.currentCommandIndex >= this.commands.length ) {

                this.isPlaying = false;

            }

        }

    }

    /**
     * Execute a single command
     * @returns {boolean} true if command completed, false if blocked
     */
    executeCommand( command, executionTime = this.currentTime, options = {} ) {

        if ( ! command ) return true;

        const shouldLog = options.log !== false;
        const controlAudio = options.audio !== false;
        const runLifecycle = options.lifecycle !== false;

        if ( shouldLog ) {

            const logParts = [ `[${executionTime.toFixed( 2 )}]`, command.type ];

            if ( command.effect ) logParts.push( command.effect );
            if ( command.args !== undefined ) logParts.push( command.args );
            if ( command.time !== undefined ) logParts.push( command.time );
            if ( command.name !== undefined ) logParts.push( command.name );
            if ( command.file !== undefined ) logParts.push( command.file );
            if ( command.loop ) logParts.push( 'LOOP' );

            if ( command.type === 'SYNCTIME' ) {

                console.log( '%c' + logParts.join( ' ' ), 'font-weight: bold' );

            } else {

                console.log( logParts.join( ' ' ) );

            }

        }

        const effect = command.effect ? this.effects.get( command.effect ) : null;

        switch ( command.type ) {

            case 'FXLOAD':
                if ( runLifecycle && effect ) {

                    effect.init();

                }
                return true;

            case 'FXSTART':
                if ( effect ) {

                    effect.start( executionTime );

                    if ( ! this.activeEffects.includes( effect ) ) {

                        this.activeEffects.push( effect );

                    }

                }
                return true;

            case 'FXSTOP':
                if ( effect ) {

                    effect.stop();

                    const index = this.activeEffects.indexOf( effect );

                    if ( index !== - 1 ) {

                        this.activeEffects.splice( index, 1 );

                    }

                }
                return true;

            case 'FXSHUT':
                if ( runLifecycle && effect ) {

                    effect.shutdown();

                }
                return true;

            case 'FXCOMMAND':
                if ( effect ) {

                    // Resource LOAD commands were awaited by preloadResources().
                    if ( ! command.preloaded ) effect.command( executionTime, command.args );

                }
                return true;

            case 'LOADMP3':
                // DemoApp loads the archived track before the timeline starts.
                return true;

            case 'PLAYMUSIC':
                if ( controlAudio && this.musicPlayer ) {

                    this.musicPlayer.play( command.loop );

                }
                return true;

            case 'STOPMUSIC':
                if ( controlAudio && this.musicPlayer ) {

                    this.musicPlayer.stop();

                }
                return true;

            case 'SYNCTIME':
                // Check if we've already reached the target time
                if ( this.currentTime >= command.time ) {

                    return true;

                }

                this.isWaiting = true;
                this.syncTargetTime = command.time;
                return false;

            case 'WAIT':
                if ( command.time <= 0 ) return true;
                this.isWaiting = true;
                this.waitStartTime = nowSeconds();
                this.waitDuration = command.time;
                return false;

            case 'SKIPTOTIME':
                if ( controlAudio && this.musicPlayer ) {

                    this.musicPlayer.seek( command.time );

                }
                return true;

            default:
                return true;

        }

    }

}
