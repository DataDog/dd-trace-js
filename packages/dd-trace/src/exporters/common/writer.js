'use strict'

const request = require('./request')
const log = require('../../log')

class Writer {
  constructor ({ url }) {
    this._url = url.toString()
  }

  flush (done = () => {}) {
    const count = this._encoder.count()

    if (!request.writable) {
      this._encoder.reset()
      done()
    } else if (count > 0) {
      const payload = this._encoder.makePayload()

      this._sendPayload(payload, count, done)
    } else {
      done()
    }
  }

  append (payload) {
    if (!request.writable) {
      log.debug(() => `Maximum number of active requests reached. Payload discarded: ${JSON.stringify(payload)}`)
      return
    }

    log.debug(() => `Encoding payload: ${JSON.stringify(payload)}`)

    this._encode(payload)
  }

  _encode (payload) {
    this._encoder.encode(payload)
  }

  setUrl (url) {
    this._url = url.toString()
  }
}

module.exports = Writer
