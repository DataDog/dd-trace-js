'use strict'

const DEFAULT_MIN_SIZE = 2 * 1024 * 1024 // 2MB

/**
 * Represents a chunk of a Msgpack payload. Exposes a subset of Array and Buffer
 * interfaces so that it can be used seamlessly by any encoder code that expects
 * either.
 */
class Chunk {
  constructor (minSize = DEFAULT_MIN_SIZE) {
    this.buffer = Buffer.allocUnsafe(minSize)
    this.length = 0
    this._minSize = minSize
  }

  push (...bytes) {
    this._reserve(bytes.length)

    this.buffer.set(bytes, this.length);
    this.length += bytes.length;
  }

  write (value) {
    const length = Buffer.byteLength(value)
    const offset = this.length

    if (length < 0x20) { // fixstr
      this._reserve(length + 1)
      this.buffer[this.length] = length | 0xa0
      this.length += 1
    } else if (length < 0x100000000) { // str 32
      this._reserve(length + 5)
      this.buffer[this.length] = 0xdb
      this.buffer.writeUInt32BE(length, this.length + 1)
      this.length += 5
    }

    this.length += this.buffer.utf8Write(value, this.length, length)

    return this.length - offset
  }

  copy (target, sourceStart, sourceEnd) {
    target.set(new Uint8Array(this.buffer.buffer, sourceStart, sourceEnd - sourceStart))
  }

  set (array) {
    this._reserve(array.length)

    this.buffer.set(array, this.length)
    this.length += array.length
  }

  _reserve (size) {
    if (this.length + size > this.buffer.length) {
      this._resize(this._minSize * Math.ceil((this.length + size) / this._minSize))
    }
  }

  _resize (size) {
    const oldBuffer = this.buffer

    this.buffer = Buffer.allocUnsafe(size)

    oldBuffer.copy(this.buffer, 0, 0, this.length)
  }
}

module.exports = Chunk
