'use strict'

const request = require('../../exporters/common/request')
const { URL, format } = require('url')

const logger = require('../../log')

const { encodeUnicode } = require('../util')
const log = require('../../log')

const {
  EVP_PROXY_AGENT_BASE_PATH,
  EVP_SUBDOMAIN_HEADER_VALUE,
  EVP_SUBDOMAIN_HEADER_NAME
} = require('../constants/writers')

class LLMObsWriter {
  constructor ({ interval, timeout, eventType, tracerConfig, endpoint, agentlessIntake }, agentless = false) {
    this._interval = interval || 1000 // 1s
    this._timeout = timeout || 5000 // 5s
    this._eventType = eventType
    this._config = tracerConfig
    this._endpoint = endpoint
    this._agentlessIntake = agentlessIntake

    this._buffer = []
    this._bufferLimit = 1000
    this._bufferSize = 0

    this._periodic = setInterval(() => {
      this.flush()
    }, this._interval).unref()

    process.once('beforeExit', () => {
      this.destroy()
    })

    process.once('uncaughtException', (err) => {
      this.destroy(() => {
        throw err
      })
    })

    process.once('unhandledRejection', (err) => {
      this.destroy(() => {
        throw err
      })
    })

    this._destroyed = false
    this._agentless = agentless

    logger.debug(`Started ${this.constructor.name}, agentless: ${agentless}`)
  }

  append (event, byteLength) {
    if (this._buffer.length >= this._bufferLimit) {
      logger.warn(`${this.constructor.name} event buffer full (limit is ${this._bufferLimit}), dropping event`)
      return
    }

    this._bufferSize += byteLength || Buffer.from(JSON.stringify(event)).byteLength
    this._buffer.push(event)
  }

  flush (_cb = () => {}) {
    if (this._buffer.length === 0) {
      return
    }

    const events = this._buffer
    this._buffer = []
    this._bufferSize = 0
    const payload = this._encode(this.makePayload(events))

    const options = this._agentless ? this._getAgentlessOptions() : this._getAgentProxyOptions()

    log.debug(`Encoded LLMObs payload: ${payload}`)

    this._makeRequest(payload, options, events.length, _cb)
  }

  makePayload (events) {}

  destroy (_cb = () => {}) {
    if (!this._destroyed) {
      logger.debug(`Stopping ${this.constructor.name}`)
      clearInterval(this._periodic)
      process.removeListener('beforeExit', this.destroy)
      this.flush(_cb)
      this._destroyed = true
    }
  }

  _makeRequest (payload, options, eventsLength, cb) {
    const baseOptions = {
      method: 'POST',
      timeout: this._timeout
    }

    options = { ...baseOptions, ...options }

    request(payload, options, (err, resp, code) => {
      if (err) {
        logger.error(
          'Error sending %d LLMObs %s events to %s: %s',
          eventsLength,
          this._eventType,
          options.url.href,
          err.message,
          err
        )

        if (!this._agentless) {
          log.info('Retrying LLM Observability with agentless data submission')
          this._agentless = true

          const agentlessOptions = this._getAgentlessOptions()

          // retry with agentless
          this._makeRequest(payload, agentlessOptions, eventsLength, cb)

          return
        }
      } else if (code >= 300) {
        logger.error(
          'Error sending %d LLMObs %s events to %s: %s',
          eventsLength,
          this._eventType,
          options.url.href,
          code
        )
      } else {
        logger.debug(
          `Sent ${eventsLength} LLMObs ${this._eventType} events to ${options.url.href}`
        )
      }

      cb(err, resp, code)
    })
  }

  _getAgentProxyOptions () {
    const headers = {
      'Content-Type': 'application/json',
      [EVP_SUBDOMAIN_HEADER_NAME]: EVP_SUBDOMAIN_HEADER_VALUE
    }

    const url = this._config.url || new URL(format({
      protocol: this._config.protocol || 'http:',
      hostname: this._config.hostname || 'localhost',
      port: this._config.port || '443',
      pathname: `${EVP_PROXY_AGENT_BASE_PATH}${this._endpoint}`
    }))

    return {
      url,
      headers
    }
  }

  _getAgentlessOptions () {
    const headers = {
      'Content-Type': 'application/json'
    }

    if (!this._config.apiKey) {
      throw new Error('Attempting to send agentless LLM Observability data without an API key')
    }
    headers['DD-API-KEY'] = this._config.apiKey

    const url = new URL(format({
      protocol: 'https:',
      hostname: this._agentlessIntake,
      pathname: this._endpoint
    }))

    return {
      url,
      headers
    }
  }

  _encode (payload) {
    return JSON.stringify(payload, (key, value) => {
      if (typeof value === 'string') {
        return encodeUnicode(value) // serialize unicode characters
      }
      return value
    }).replace(/\\\\u/g, '\\u') // remove double escaping
  }
}

module.exports = LLMObsWriter
