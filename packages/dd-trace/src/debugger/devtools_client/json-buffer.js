'use strict'

class JSONBuffer {
  #maxSize
  #timeout
  #onFlush
  #timer
  #partialJson

  constructor ({ size, timeout, onFlush }) {
    this.#maxSize = size
    this.#timeout = timeout
    this.#onFlush = onFlush
    this.#reset()
  }

  #reset () {
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#partialJson = undefined
  }

  #flush () {
    const json = `${this.#partialJson}]`
    this.#reset()
    this.#onFlush(json)
  }

  write (str, size = Buffer.byteLength(str)) {
    if (this.#timer === undefined) {
      this.#partialJson = `[${str}`
      this.#timer = setTimeout(() => this.#flush(), this.#timeout)
    } else if (Buffer.byteLength(/** @type {string} */ (this.#partialJson)) + size + 2 > this.#maxSize) {
      this.#flush()
      this.write(str, size)
    } else {
      this.#partialJson += `,${str}`
    }
  }
}

module.exports = JSONBuffer
