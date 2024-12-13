'use strict'

const textEncoder = new TextEncoder()

const DEFAULT_MIN_SIZE = 1 * 1024 * 1024 // 2MB

class Chunk {
  constructor (minSize = DEFAULT_MIN_SIZE) {
    this.buffer = new Uint8Array(minSize)
    this.length = 0
    this._minSize = minSize
  }

  write (value) {
    const maxLength = value.length * 4
    const offset = this.length

    if (maxLength <= 0xFF) { // str 8
      this.reserve(maxLength + 2)
      this.length += 2
      this.buffer[offset] = 0xd9
      const written = textEncoder.encodeInto(value, this.buffer.subarray(this.length)).written
      this.buffer[offset + 1] = written
      this.length += written
    } else if (maxLength <= 0xFFFF) { // str 16
      this.reserve(maxLength + 3)
      this.length += 3
      this.buffer[offset] = 0xda
      const written = textEncoder.encodeInto(value, this.buffer.subarray(this.length)).written
      this.buffer[offset + 1] = written >> 8
      this.buffer[offset + 2] = written
      this.length += written
    } else if (maxLength <= 0xFFFFFFFF) { // str 32
      this.reserve(maxLength + 5)
      this.length += 5
      this.buffer[offset] = 0xdb
      const written = textEncoder.encodeInto(value, this.buffer.subarray(this.length)).written
      this.buffer[offset + 1] = written >> 24
      this.buffer[offset + 2] = written >> 16
      this.buffer[offset + 3] = written >> 8
      this.buffer[offset + 4] = written
      this.length += written
    }

    return this.length - offset
  }

  copy (target, sourceStart, sourceEnd) {
    target.set(new Uint8Array(this.buffer.buffer, sourceStart, sourceEnd - sourceStart))
  }

  set (typedArray) {
    typedArray = new Uint8Array(typedArray.buffer, 0, typedArray.byteLength)

    this.reserve(typedArray.byteLength)

    this.buffer.set(typedArray, this.length)
    this.length += typedArray.byteLength
  }

  reserve (size) {
    if (this.length + size > this.buffer.length) {
      this._resize(this._minSize * Math.ceil((this.length + size) / this._minSize))
    }
  }

  _resize (size) {
    const oldBuffer = this.buffer

    this.buffer = new Uint8Array(size)
    this.buffer.set(oldBuffer)
  }
}

module.exports = Chunk
