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
  }

  #flush () {
    const json = `${this.#partialJson}]`
    this.#partialJson = undefined
    this.#onFlush(json)
  }

  write (str, size = Buffer.byteLength(str)) {
    if (this.#partialJson === undefined) {
      this.#partialJson = `[${str}`
      if (this.#timer === undefined) {
        this.#timer = setTimeout(() => this.#flush(), this.#timeout)
      } else {
        this.#timer.refresh()
      }
    } else if (Buffer.byteLength(this.#partialJson) + size + 2 > this.#maxSize) {
      clearTimeout(this.#timer)
      this.#timer = undefined
      this.#flush()
      this.write(str, size)
    } else {
      this.#partialJson += `,${str}`
    }
  }
}

module.exports = JSONBuffer
