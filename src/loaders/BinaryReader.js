/**
 * BinaryReader - DataView wrapper for reading binary files
 * Provides little-endian reading by default (matching DirectX 8 format)
 */
export class BinaryReader {

    constructor( buffer, offset = 0 ) {

        this.buffer = buffer;
        this.view = new DataView( buffer );
        this.offset = offset;
        this.littleEndian = true;

    }

    get position() {

        return this.offset;

    }

    set position( value ) {

        this.offset = value;

    }

    get length() {

        return this.buffer.byteLength;

    }

    get remaining() {

        return this.buffer.byteLength - this.offset;

    }

    seek( offset ) {

        this.offset = offset;
        return this;

    }

    skip( bytes ) {

        this.offset += bytes;
        return this;

    }

    align( boundary ) {

        const remainder = this.offset % boundary;
        if ( remainder !== 0 ) {

            this.offset += boundary - remainder;

        }
        return this;

    }

    // Integer types

    readInt8() {

        const value = this.view.getInt8( this.offset );
        this.offset += 1;
        return value;

    }

    readUint8() {

        const value = this.view.getUint8( this.offset );
        this.offset += 1;
        return value;

    }

    readInt16() {

        const value = this.view.getInt16( this.offset, this.littleEndian );
        this.offset += 2;
        return value;

    }

    readUint16() {

        const value = this.view.getUint16( this.offset, this.littleEndian );
        this.offset += 2;
        return value;

    }

    readInt32() {

        const value = this.view.getInt32( this.offset, this.littleEndian );
        this.offset += 4;
        return value;

    }

    readUint32() {

        const value = this.view.getUint32( this.offset, this.littleEndian );
        this.offset += 4;
        return value;

    }

    // Floating point

    readFloat32() {

        const value = this.view.getFloat32( this.offset, this.littleEndian );
        this.offset += 4;
        return value;

    }

    readFloat64() {

        const value = this.view.getFloat64( this.offset, this.littleEndian );
        this.offset += 8;
        return value;

    }

    // Arrays

    readInt8Array( count ) {

        const array = new Int8Array( count );
        for ( let i = 0; i < count; i ++ ) {

            array[ i ] = this.readInt8();

        }
        return array;

    }

    readUint8Array( count ) {

        const array = new Uint8Array( this.buffer, this.offset, count );
        this.offset += count;
        return new Uint8Array( array ); // Return copy

    }

    readInt16Array( count ) {

        const array = new Int16Array( count );
        for ( let i = 0; i < count; i ++ ) {

            array[ i ] = this.readInt16();

        }
        return array;

    }

    readUint16Array( count ) {

        const array = new Uint16Array( count );
        for ( let i = 0; i < count; i ++ ) {

            array[ i ] = this.readUint16();

        }
        return array;

    }

    readInt32Array( count ) {

        const array = new Int32Array( count );
        for ( let i = 0; i < count; i ++ ) {

            array[ i ] = this.readInt32();

        }
        return array;

    }

    readUint32Array( count ) {

        const array = new Uint32Array( count );
        for ( let i = 0; i < count; i ++ ) {

            array[ i ] = this.readUint32();

        }
        return array;

    }

    readFloat32Array( count ) {

        const array = new Float32Array( count );
        for ( let i = 0; i < count; i ++ ) {

            array[ i ] = this.readFloat32();

        }
        return array;

    }

    // Strings

    readString( length ) {

        const bytes = this.readUint8Array( length );
        let str = '';
        for ( let i = 0; i < bytes.length; i ++ ) {

            if ( bytes[ i ] === 0 ) break;
            str += String.fromCharCode( bytes[ i ] );

        }
        return str;

    }

    readNullTerminatedString() {

        let str = '';
        while ( this.offset < this.buffer.byteLength ) {

            const byte = this.readUint8();
            if ( byte === 0 ) break;
            str += String.fromCharCode( byte );

        }
        return str;

    }

    readPascalString() {

        const length = this.readUint8();
        return this.readString( length );

    }

    // 32-bit length-prefixed string (used in 3PX format)
    readLengthPrefixedString() {

        const length = this.readInt32();
        if ( length <= 0 ) return '';
        return this.readString( length );

    }

    // Vectors

    readVector2() {

        return {
            x: this.readFloat32(),
            y: this.readFloat32()
        };

    }

    readVector3() {

        return {
            x: this.readFloat32(),
            y: this.readFloat32(),
            z: this.readFloat32()
        };

    }

    // Read Vector3 and convert from DirectX (left-handed) to OpenGL (right-handed)
    readVector3GL() {

        return {
            x: this.readFloat32(),
            y: this.readFloat32(),
            z: - this.readFloat32()  // Negate Z for coordinate system conversion
        };

    }

    readVector4() {

        return {
            x: this.readFloat32(),
            y: this.readFloat32(),
            z: this.readFloat32(),
            w: this.readFloat32()
        };

    }

    readQuaternion() {

        const w = this.readFloat32();  // First in file (C++ struct order)
        const x = this.readFloat32();
        const y = this.readFloat32();
        const z = this.readFloat32();
        return { x, y, z, w };

    }

    // Read Quaternion and convert from DirectX (left-handed) to OpenGL (right-handed)
    readQuaternionGL() {

        const w = this.readFloat32();
        const x = this.readFloat32();
        const y = this.readFloat32();
        const z = this.readFloat32();
        // Negate X and Y to convert rotation handedness
        return { x: - x, y: - y, z, w };

    }

    // Color in D3DCOLOR ARGB format
    readColorARGB() {

        const value = this.readUint32();
        return {
            a: ( value >> 24 ) & 0xFF,
            r: ( value >> 16 ) & 0xFF,
            g: ( value >> 8 ) & 0xFF,
            b: value & 0xFF
        };

    }

    // Color (RGBA format)
    readColorRGBA() {

        return {
            r: this.readUint8(),
            g: this.readUint8(),
            b: this.readUint8(),
            a: this.readUint8()
        };

    }

    // Utility

    clone() {

        const reader = new BinaryReader( this.buffer, this.offset );
        reader.littleEndian = this.littleEndian;
        return reader;

    }

    slice( start, end ) {

        return new BinaryReader( this.buffer.slice( start, end ) );

    }

}
