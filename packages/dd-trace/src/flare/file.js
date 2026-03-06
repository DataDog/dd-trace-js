'use strict'

const { Writable } = require('stream')

const INITIAL_SIZE = 64 * 1024

class FlareFile extends Writable {
  #buffer

  constructor () {
    super()

    this.length = 0

    this.#buffer = Buffer.alloc(INITIAL_SIZE)
  }

  get data () {
    return this.#buffer.subarray(0, this.length)
  }

  _write (chunk, encoding, callback) {
    const length = Buffer.byteLength(chunk)

    this._reserve(length)

    this.length += Buffer.isBuffer(chunk) ? chunk.copy(this.#buffer, this.length) : this.#buffer.write(chunk, encoding)

    callback()
  }

  _reserve (length) {
    while (this.length + length > this.#buffer.length) {
      const buffer = Buffer.alloc(this.length * 2)

      this.#buffer.copy(buffer)
      this.#buffer = buffer
    }
  }
}

module.exports = FlareFile
