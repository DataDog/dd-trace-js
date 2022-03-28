'use strict'
const log = require('../../log')

class Writer {
  constructor ({ url }) {
    this._url = url
  }

  flush (done = () => {}) {
    const count = this._encoder.count()

    if (count > 0) {
      const payload = this._encoder.makePayload()

      this._sendPayload(payload, count, done)
    } else {
      done()
    }
  }

  append (spans) {
    log.debug(() => `Encoding trace: ${JSON.stringify(spans)}`)

    this._encode(spans)
  }

  _encode (trace) {
    this._encoder.encode(trace)
  }

  setUrl (url) {
    this._url = url
  }
}

module.exports = Writer
