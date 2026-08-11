import * as THREE from 'three';

const MIME_TYPES = {
    bmp: 'image/bmp',
    gif: 'image/gif',
    png: 'image/png'
};

/**
 * TextureLoader - Helper for loading textures from ArrayBuffers
 */
export class TextureLoader {

    constructor() {

        this.textureCache = new Map();

    }

    /**
     * Load a texture from an ArrayBuffer
     * @param {ArrayBuffer} buffer - Image data
     * @param {string} path - Original file path (for cache key and format detection)
     * @param {Object} options - Optional settings
     * @param {boolean} options.flipY - Whether to flip texture vertically (default: true)
     * @returns {Promise<THREE.Texture>}
     */
    async loadFromBuffer( buffer, path, { flipY = true } = {} ) {

        const cacheKey = path.toLowerCase();
        const cachedTexture = this.textureCache.get( cacheKey );

        if ( cachedTexture ) {

            return cachedTexture;

        }

        const ext = path.split( '.' ).pop().toLowerCase();

        if ( ext === 'tga' ) {

            console.warn( `TextureLoader: TGA format not supported: ${path}` );
            return null;

        }

        const mimeType = MIME_TYPES[ ext ] || 'image/jpeg';
        const blob = new Blob( [ buffer ], { type: mimeType } );
        const url = URL.createObjectURL( blob );

        return new Promise( ( resolve, reject ) => {

            const image = new Image();

            image.onload = () => {

                URL.revokeObjectURL( url );

                const texture = new THREE.Texture( image );
                texture.flipY = flipY;

                // The original D3D8 renderer had no sRGB decode/encode stage. Keep
                // both color and mask images untagged so blending happens on their
                // stored byte values, matching the 2001 framebuffer behavior.
                texture.colorSpace = THREE.NoColorSpace;

                // Set default texture parameters
                texture.wrapS = THREE.RepeatWrapping;
                texture.wrapT = THREE.RepeatWrapping;
                texture.minFilter = THREE.LinearMipmapLinearFilter;
                texture.magFilter = THREE.LinearFilter;
                texture.needsUpdate = true;

                this.textureCache.set( cacheKey, texture );

                resolve( texture );

            };

            image.onerror = () => {

                URL.revokeObjectURL( url );
                console.warn( `TextureLoader: Failed to load texture: ${path}` );
                reject( new Error( `Failed to load texture: ${path}` ) );

            };

            image.src = url;

        } );

    }

    /**
     * Clear the texture cache
     */
    clearCache() {

        for ( const texture of this.textureCache.values() ) {

            texture.dispose();

        }

        this.textureCache.clear();

    }

    /**
     * Dispose of resources
     */
    dispose() {

        this.clearCache();

    }

}
