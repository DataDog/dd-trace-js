'use strict'

const URL = require('url-parse')

const MAX_SIZE = 64 * 1024 // 64kb
const DELIMITER = '\r\n'

// TODO: rename and refactor to support Node
// TODO: flush more often

class BrowserExporter {
  constructor ({ clientToken, url, env }) {
    this._queue = []
    this._flushing = false
    this._clientToken = clientToken
    this._env = env
    this._url = url || new URL('https://public-trace-http-intake.logs.datadoghq.com')
    this._size = 0

    window.addEventListener('beforeunload', () => this._flush())
    window.addEventListener('visibilitychange', () => this._flush())
  }

  export (spans) {
    const env = this._env
    const json = JSON.stringify({ spans, env })
    const size = json.length + (this._queue.length > 0 ? DELIMITER.length : 0)

    if (this._size + size > MAX_SIZE) {
      if (this._flushing) return // drop trace to avoid multiple connections
      if (size > MAX_SIZE) return // drop trace because too large

      this._flush()
    }

    this._size += size
    this._queue.push(json)
  }

  _flush () {
    if (this._queue.length === 0) return

    this._flushing = true

    const url = `${this._url.href}/v1/input/${this._clientToken}`
    const method = 'POST'
    const body = this._queue.join(DELIMITER)
    const keepalive = true
    const mode = 'no-cors'
    const done = () => {
      this._flushing = false
    }

    this._queue = []
    this._size = 0

    window.fetch(url, { body, method, keepalive, mode })
      .then(done, done)
  }
}

module.exports = BrowserExporter
