'use strict'

const { Writable } = require('stream')

const INITIAL_SIZE = 64 * 1024

class FlareFile extends Writable {
  #buffer = Buffer.alloc(INITIAL_SIZE)
  #length = 0

  get data () {
    return this.#buffer.subarray(0, this.#length)
  }

  // Method needed for Writable stream interface
  _write (chunk, encoding, callback) {
    const length = Buffer.byteLength(chunk)

    this.#reserve(length)

    this.#length += Buffer.isBuffer(chunk) ? chunk.copy(this.#buffer, this.#length) : this.#buffer.write(chunk, encoding)

    callback()
  }

  #reserve (length) {
    const needed = this.#length + length
    if (needed <= this.#buffer.length) {
      return
    }

    // Double capacity until it's >= needed
    let newCap = this.#buffer.length * 2
    while (newCap < needed) {
      newCap *= 2
    }

    const newBuffer = Buffer.allocUnsafe(newCap)
    this.#buffer.copy(newBuffer, 0, 0, this.#length)
    this.#buffer = newBuffer
  }
}

module.exports = FlareFile
