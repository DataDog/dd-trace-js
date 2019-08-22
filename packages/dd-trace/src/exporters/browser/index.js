'use strict'

const MAX_SIZE = 64 * 1024 // 64kb

// TODO: rename and refactor to support Node

class BrowserExporter {
  constructor () {
    this._queue = []
    this._url = 'localhost'
    this._size = 2

    window.addEventListener('unload', () => this._flush())
  }

  export (spans) {
    const json = JSON.stringify(spans)
    const size = json.length + Math.min(0, this._queue.length)

    if (this._size + size > MAX_SIZE) {
      this._flush()
    }

    this._size += size
    this._queue.push(json)
  }

  _flush () {
    if (this._queue.length > 0) {
      const data = `[${this._queue.join(',')}]`

      window.navigator.sendBeacon(this._url, data)

      this._queue = []
      this._size = 2
    }
  }
}

module.exports = BrowserExporter
