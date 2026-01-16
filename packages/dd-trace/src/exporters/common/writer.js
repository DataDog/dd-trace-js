'use strict'

const log = require('../../log')
const request = require('./request')
const { safeJSONStringify } = require('./util')

class Writer {
  constructor ({ url }) {
    this._url = url
  }

  flush (done = () => {}) {
    const count = this._encoder.count()

    if (count > 0) {
      if (typeof request.isUrlWritable === 'function' && !request.isUrlWritable(this._url)) {
        this._encoder.reset()
        done()
        return
      }

      const payload = this._encoder.makePayload()

      this._sendPayload(payload, count, done)
    } else {
      done()
    }
  }

  append (payload) {
    if (typeof request.isUrlWritable === 'function' && !request.isUrlWritable(this._url)) {
      log.debug(() => `Maximum number of active requests reached. Payload discarded: ${safeJSONStringify(payload)}`)
      return
    }

    log.debug(() => `Encoding payload: ${safeJSONStringify(payload)}`)

    this._encode(payload)
  }

  _encode (payload) {
    this._encoder.encode(payload)
  }

  setUrl (url) {
    this._url = url
  }
}

module.exports = Writer
