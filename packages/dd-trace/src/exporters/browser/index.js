'use strict'

const { fetch } = require('whatwg-fetch')

const MAX_SIZE = 4 * 1024 // 64kb

// TODO: rename and refactor to support Node
// TODO: flush more often
// TODO: support setting backend URL as a config option

class BrowserExporter {
  constructor ({ clientToken }) {
    this._queue = []
    this._clientToken = clientToken
    this._url = window.DD_TRACE_URL || 'https://public-trace-http-intake.logs.datadoghq.com'
    this._size = 0

    window.addEventListener('beforeunload', () => this._flush())
    window.addEventListener('visibilitychange', () => this._flush())
  }

  export (spans) {
    const json = `{spans:${JSON.stringify(spans)}}`
    const size = json.length + Math.min(0, this._queue.length)

    if (this._size + size > MAX_SIZE) {
      this._flush()
    }

    this._size += size
    this._queue.push(json)
  }

  _flush () {
    if (this._queue.length === 0) return

    const url = `${this._url}/v1/input/${this._clientToken}`
    const method = 'POST'
    const body = this._queue.join('\n')
    const keepalive = true
    const mode = 'no-cors'
    const done = () => {}

    this._queue = []
    this._size = 0

    fetch(url, { body, method, keepalive, mode })
      .then(done, done)
  }
}

module.exports = BrowserExporter
