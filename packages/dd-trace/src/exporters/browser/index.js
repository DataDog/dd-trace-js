'use strict'

const MAX_SIZE = 64 * 1024 // 64kb

// TODO: rename and refactor to support Node

class BrowserExporter {
  constructor ({ apiKey, appKey }) {
    this._queue = []
    this._apiKey = apiKey
    this._appKey = appKey
    this._url = `https://dd.datad0g.com/trace/api/experimental/intake` // TODO: config
    this._size = 13

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
      const url = `${this._url}?api_key=${this._apiKey}&application_key=${this._appKey}`
      const data = `{"traces":[${this._queue.join(',')}]}`

      window.navigator.sendBeacon(url, data)

      this._queue = []
      this._size = 13
    }
  }
}

module.exports = BrowserExporter
