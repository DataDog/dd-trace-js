'use strict'

class JSONQueue {
  constructor ({ size, timeout, onFlush }) {
    this._maxSize = size
    this._timeout = timeout
    this._onFlush = onFlush
    this._reset()
  }

  _reset () {
    clearTimeout(this._timer)
    this._timer = null
    this._partialJson = null
  }

  _flush () {
    const json = `${this._partialJson}]`
    this._reset()
    this._onFlush(json)
  }

  add (str, size = Buffer.byteLength(str)) {
    if (this._timer === null) {
      this._partialJson = `[${str}`
      this._timer = setTimeout(() => this._flush(), this._timeout)
    } else if (Buffer.byteLength(this._partialJson) + size + 2 > this._maxSize) {
      this._flush()
      this.add(str, size)
    } else {
      this._partialJson += `,${str}`
    }
  }
}

module.exports = JSONQueue
