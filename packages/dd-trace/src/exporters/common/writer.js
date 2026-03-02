'use strict'

const { channel } = require('dc-polyfill')

const log = require('../../log')
const request = require('./request')
const { safeJSONStringify } = require('./util')

const firstFlushChannel = channel('dd-trace:exporter:first-flush')

class Writer {
  constructor ({ url, beforeFirstFlush }) {
    this._url = url
    this._beforeFirstFlush = beforeFirstFlush
  }

  #isFirstFlush = true

  flush (done = () => {}) {
    const count = this._encoder.count()

    if (!request.writable) {
      this._encoder.reset()
      done()
    } else if (count > 0) {
      if (this.#isFirstFlush && firstFlushChannel.hasSubscribers && this._beforeFirstFlush) {
        this.#isFirstFlush = false
        this._beforeFirstFlush()
      }
      const payload = this._encoder.makePayload()
      this._sendPayload(payload, count, done)
    } else {
      done()
    }
  }

  append (payload) {
    if (!request.writable) {
      // eslint-disable-next-line eslint-rules/eslint-log-printf-style
      log.debug(() => `Maximum number of active requests reached. Payload discarded: ${safeJSONStringify(payload)}`)
      return
    }

    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
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
