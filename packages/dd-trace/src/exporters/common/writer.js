'use strict'

const { channel } = require('dc-polyfill')

const log = require('../../log')
const { MAX_SIZE: MAX_CHUNK_SIZE } = require('../../msgpack')
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
      let payload
      try {
        payload = this._encoder.makePayload()
      } catch (error) {
        if (error.code !== 'ERR_MSGPACK_CHUNK_OVERFLOW') throw error
        // Multi-chunk encoders (v0.5, CI Visibility) only learn the assembled
        // payload exceeds the cap when `makePayload` stitches the chunks
        // together, after `encode` already returned — so the encode-time catch
        // never sees it. Drop the queued payload here instead of letting the
        // RangeError escape into the host application; the agent would reject
        // the oversized payload at the network boundary anyway.
        this._encoder.reset()
        log.error('Writer dropped %d trace(s) that exceeded the %d byte chunk cap', count, MAX_CHUNK_SIZE)
        done()
        return
      }
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
