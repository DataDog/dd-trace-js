'use strict'

const request = require('../../exporters/common/request')
const { URL, format } = require('url')

const logger = require('../../log')

const { encodeUnicode } = require('../utils')

class BaseLLMObsWriter {
  constructor ({ site, apiKey, interval, timeout, endpoint, intake, eventType }) {
    this._site = site
    this._apiKey = apiKey
    this._interval = interval || 1000 // 1s
    this._timeout = timeout || 5000 // 5s
    this._endpoint = endpoint
    this._intake = intake
    this._eventType = eventType

    this._buffer = []
    this._bufferLimit = 1000

    this._url = new URL(format({
      protocol: 'https:',
      hostname: this._intake,
      port: 443,
      pathname: this._endpoint
    }))

    this._headers = {
      'DD-API-KEY': this._apiKey,
      'Content-Type': 'application/json'
    }

    this._periodic = setInterval(this.flush.bind(this), this._interval).unref()
    process.once('beforeExit', () => {
      clearInterval(this._periodic)
      this.flush()
    })
  }

  append (event) {
    if (this._buffer.length < this._bufferLimit) {
      this._buffer.push(event)
    }
  }

  flush () {
    if (this._buffer.length === 0) {
      return
    }

    const events = this._buffer
    this._buffer = []
    const payload = encodeUnicode(JSON.stringify(this.makePayload(events)))

    const options = {
      headers: this._headers,
      method: 'POST',
      url: this._url
    }

    request(payload, options, (err, resp, code) => {
      if (err) {
        logger.error(
          `Error sending ${events.length} LLMObs ${this._eventType} events to ${this._url}: ${err.message}`
        )
      }
      if (code >= 300) {
        logger.error(
          `Error sending ${events.length} LLMObs ${this._eventType} events to ${this._url}: ${code}`
        )
      } else {
        logger.debug(`Sent ${events.length} LLMObs ${this._eventType} events to ${this._url}`)
      }
    })
  }

  makePayload (events) {}
}

module.exports = BaseLLMObsWriter
