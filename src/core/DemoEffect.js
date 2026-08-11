/**
 * DemoEffect - Base class for demo effects
 * Provides lifecycle methods and command handling
 */
export class DemoEffect {

    constructor( name ) {

        this.name = name;
        this.layer = 0;
        this.startTime = 0;
        this.isActive = false;
        this.isInitialized = false;

    }

    /**
     * Initialize the effect (load resources)
     * @returns {number} 0 on success, -1 on error
     */
    init() {

        this.isInitialized = true;
        return 0;

    }

    /**
     * Shutdown the effect (release resources)
     * @returns {number} 0 on success, -1 on error
     */
    shutdown() {

        this.isInitialized = false;
        this.isActive = false;
        return 0;

    }

    /**
     * Start the effect
     * @param {number} time - Current demo time in seconds
     * @returns {number} 0 on success, -1 on error
     */
    start( time ) {

        this.startTime = time;
        this.isActive = true;
        return 0;

    }

    /**
     * Stop the effect
     * @returns {number} 0 on success, -1 on error
     */
    stop() {

        this.isActive = false;
        return 0;

    }

    /**
     * Set the rendering layer
     * @param {number} layer - Layer index (0-15)
     */
    setLayer( layer ) {

        this.layer = layer;

    }

    /**
     * Main update/run method
     * @param {number} time - Current demo time in seconds
     * @param {number} deltaTime - Time since last frame
     * @returns {boolean} true to continue, false to stop
     */
    update( time, deltaTime ) {

        // Override in subclass
        return this.isActive;

    }

    /**
     * Render the effect
     * @param {THREE.WebGLRenderer} renderer
     * @param {THREE.Scene} scene
     * @param {THREE.Camera} camera
     */
    render( renderer, scene, camera ) {

        // Override in subclass

    }

    /**
     * Process a command from the script
     * @param {number} time - Current demo time in seconds
     * @param {string} commandString - Command arguments as a string
     * @returns {number} 0 on success, -1 on error
     */
    command( time, commandString ) {

        // Parse command string into tokens
        const args = this.parseArgs( commandString );

        if ( args.length === 0 ) return - 1;

        const cmd = args[ 0 ].toUpperCase();

        return this.handleCommand( time, cmd, args.slice( 1 ) );

    }

    /**
     * Handle a parsed command
     * @param {number} time - Current demo time
     * @param {string} cmd - Command name
     * @param {string[]} args - Command arguments
     * @returns {number} 0 on success, -1 on error
     */
    handleCommand( time, cmd, args ) {

        // Override in subclass
        console.warn( `${this.name}: Unknown command "${cmd}"` );
        return - 1;

    }

    /**
     * Parse command arguments from a string
     * @param {string} str - Argument string
     * @returns {string[]} Array of arguments
     */
    parseArgs( str ) {

        if ( ! str ) return [];

        const args = [];
        let current = '';
        let inQuotes = false;

        for ( let i = 0; i < str.length; i ++ ) {

            const char = str[ i ];

            if ( char === '"' ) {

                inQuotes = ! inQuotes;

            } else if ( ( char === ' ' || char === '\t' ) && ! inQuotes ) {

                if ( current ) {

                    args.push( current );
                    current = '';

                }

            } else {

                current += char;

            }

        }

        if ( current ) {

            args.push( current );

        }

        return args;

    }

    /**
     * Get the local time (time since effect started)
     * @param {number} time - Current demo time
     * @returns {number} Local time
     */
    getLocalTime( time ) {

        return time - this.startTime;

    }

}
