import { unzip } from 'fflate';

const textDecoder = new TextDecoder();

/**
 * DataArchive - ZIP archive extractor for demo data
 * Wraps fflate for easy file access
 */
export class DataArchive {

    constructor() {

        this.files = new Map();
        this.isLoaded = false;

    }

    /**
     * Load a ZIP archive from a URL or ArrayBuffer
     * @param {string|ArrayBuffer} source - URL or ArrayBuffer of ZIP data
     * @returns {Promise<void>}
     */
    async load( source ) {

        let arrayBuffer;

        if ( typeof source === 'string' ) {

            const response = await fetch( source );

            if ( ! response.ok ) {

                throw new Error( `Failed to fetch archive: ${response.status}` );

            }

            arrayBuffer = await response.arrayBuffer();

        } else {

            arrayBuffer = source;

        }

        const data = new Uint8Array( arrayBuffer );

        const unzipped = await new Promise( ( resolve, reject ) => {

            unzip( data, ( err, result ) => {

                if ( err ) {

                    reject( err );

                } else {

                    resolve( result );

                }

            } );

        } );

        // Build file map with lowercase keys for case-insensitive lookup
        this.files.clear();

        for ( const [ path, content ] of Object.entries( unzipped ) ) {

            // Skip directories (they have zero-length content)
            if ( content.length > 0 ) {

                this.files.set( path.toLowerCase(), content );

            }

        }

        this.isLoaded = true;

    }

    /**
     * Get a file from the archive as an ArrayBuffer
     * @param {string} path - File path (case-insensitive)
     * @returns {Promise<ArrayBuffer|null>}
     */
    async getFile( path ) {

        const content = this._getContent( path );
        if ( ! content ) return null;

        return content.buffer.slice( content.byteOffset, content.byteOffset + content.byteLength );

    }

    /**
     * Get a file from the archive as a string
     * @param {string} path - File path (case-insensitive)
     * @returns {Promise<string|null>}
     */
    async getFileAsText( path ) {

        const content = this._getContent( path );
        if ( ! content ) return null;

        return textDecoder.decode( content );

    }

    /**
     * Resolve an archive path case-insensitively and with either path separator.
     * @param {string} path
     * @returns {Uint8Array|null}
     */
    _getContent( path ) {

        if ( ! this.isLoaded ) {

            console.warn( 'DataArchive: Archive not loaded' );
            return null;

        }

        const key = path.toLowerCase();
        const variations = [
            key,
            key.replace( /\//g, '\\' ),
            key.replace( /\\/g, '/' ),
            key.replace( /^\//, '' ),
            key.replace( /^data\//, '' )
        ];

        for ( const variant of variations ) {

            const content = this.files.get( variant );
            if ( content ) return content;

        }

        return null;

    }

    /**
     * Get list of all file paths
     * @returns {string[]}
     */
    getFileList() {

        return [ ...this.files.keys() ];

    }

    /**
     * Dispose of resources
     */
    dispose() {

        this.files.clear();
        this.isLoaded = false;

    }

}
