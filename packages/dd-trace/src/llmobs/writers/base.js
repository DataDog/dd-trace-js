'use strict'

const request = require('../../exporters/common/request')
const { URL, format } = require('url')

const logger = require('../../log')

class BaseLLMObsWriter {
  constructor (site, apiKey, interval, timeout) {
    this._site = site
    this._apiKey = apiKey
    this._interval = interval || 1000 // 1s
    this._timeout = timeout || 5000 // 5s

    this._buffer = []
    this._bufferLimit = 1000

    // to be set by implementors
    this._endpoint = undefined
    this._intake = undefined
    this._eventType = undefined

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

  get _url () {
    return new URL(format({
      protocol: 'https:',
      hostname: this._intake,
      port: 443,
      pathname: this._endpoint
    }))
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
    const payload = JSON.stringify(this.makePayload(events))

    const options = {
      // path: this._endpoint,
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
