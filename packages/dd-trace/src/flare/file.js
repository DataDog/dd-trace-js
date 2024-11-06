'use strict'

const { Writable } = require('stream')

const INITIAL_SIZE = 64 * 1024

class FlareFile extends Writable {
  constructor () {
    super()

    this.length = 0

    this._buffer = Buffer.alloc(INITIAL_SIZE)
  }

  get data () {
    return this._buffer.subarray(0, this.length)
  }

  _write (chunk, encoding, callback) {
    const length = Buffer.byteLength(chunk)

    this._reserve(length)

    if (Buffer.isBuffer(chunk)) {
      this.length += chunk.copy(this._buffer, this.length)
    } else {
      this.length += this._buffer.write(chunk, encoding)
    }

    callback()
  }

  _reserve (length) {
    while (this.length + length > this._buffer.length) {
      const buffer = Buffer.alloc(this.length * 2)

      this._buffer.copy(buffer)
      this._buffer = buffer
    }
  }
}

module.exports = FlareFile
