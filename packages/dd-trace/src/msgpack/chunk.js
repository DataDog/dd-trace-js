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
    this.view = new DataView(this.buffer.buffer)
    this.length = 0
    this._minSize = minSize
  }

  write (value) {
    const length = Buffer.byteLength(value)
    const offset = this.length

    if (length < 0x20) { // fixstr
      this.reserve(length + 1)
      this.buffer[offset] = length | 0xa0
    } else if (length < 0x100000000) { // str 32
      this.reserve(length + 5)
      this.buffer[offset] = 0xdb
      this.buffer[offset + 1] = length >> 24
      this.buffer[offset + 2] = length >> 16
      this.buffer[offset + 3] = length >> 8
      this.buffer[offset + 4] = length
    }

    this.buffer.utf8Write(value, this.length - length, length)

    return this.length - offset
  }

  copy (target, sourceStart, sourceEnd) {
    target.set(new Uint8Array(this.buffer.buffer, sourceStart, sourceEnd - sourceStart))
  }

  set (array) {
    const length = this.length

    this.reserve(array.length)

    this.buffer.set(array, length)
  }

  reserve (size) {
    if (this.length + size > this.buffer.length) {
      this._resize(this._minSize * Math.ceil((this.length + size) / this._minSize))
    }

    this.length += size
  }

  _resize (size) {
    const oldBuffer = this.buffer

    this.buffer = Buffer.allocUnsafe(size)
    this.view = new DataView(this.buffer.buffer)

    oldBuffer.copy(this.buffer, 0, 0, this.length)
  }
}

module.exports = Chunk
