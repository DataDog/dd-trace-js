'use strict'

const { channel } = require('dc-polyfill')

const log = require('../../log')
const request = require('./request')
const { safeJSONStringify } = require('./util')

const firstFlushChannel = channel('dd-trace:exporter:first-flush')

class Writer {
  constructor ({ url, beforeFirstFlush, trackPayloads }) {
    this._url = url
    this._beforeFirstFlush = beforeFirstFlush
    this._payloads = trackPayloads ? [] : undefined
  }

  #isFirstFlush = true

  flush (done = () => {}) {
    const count = this._encoder.count()

    if (!request.writable) {
      this._encoder.reset()
      this._resetPayloads()
      done()
    } else if (count > 0) {
      if (this.#isFirstFlush && firstFlushChannel.hasSubscribers && this._beforeFirstFlush) {
        this.#isFirstFlush = false
        this._beforeFirstFlush()
      }
      const payload = this._encoder.makePayload()
      this._resetPayloads()
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

    this._trackPayload(payload)

    try {
      this._encode(payload)
    } catch (err) {
      this._untrackLastPayload()
      throw err
    }

    return true
  }

  _encode (payload) {
    this._encoder.encode(payload)
  }

  setUrl (url) {
    this._url = url
  }

  /**
   * Removes payloads that have been encoded but not flushed.
   *
   * @returns {Array<object[]>|undefined} Pending payloads, or undefined when payload tracking is disabled.
   */
  drain () {
    if (this._payloads === undefined) return

    const payloads = this._payloads
    this._payloads = []
    this._encoder.reset()
    return payloads
  }

  /**
   * Records a payload that may need to be moved before it is flushed.
   *
   * @param {object[]} payload
   * @returns {void}
   */
  _trackPayload (payload) {
    this._payloads?.push(payload)
  }

  /**
   * Removes the most recent tracked payload after an encode failure.
   *
   * @returns {void}
   */
  _untrackLastPayload () {
    this._payloads?.pop()
  }

  /**
   * Clears the tracked payloads after they have been flushed or dropped.
   *
   * @returns {void}
   */
  _resetPayloads () {
    if (this._payloads !== undefined) {
      this._payloads = []
    }
  }
}

module.exports = Writer
