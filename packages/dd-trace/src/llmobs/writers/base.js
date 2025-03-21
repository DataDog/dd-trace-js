'use strict'

const request = require('../../exporters/common/request')
const { URL, format } = require('node:url')
const path = require('node:path')

const logger = require('../../log')

const { encodeUnicode } = require('../util')
const log = require('../../log')
const {
  EVP_SUBDOMAIN_HEADER_NAME,
  EVP_PROXY_AGENT_BASE_PATH
} = require('../constants/writers')

class BaseLLMObsWriter {
  constructor ({ interval, timeout, eventType, config, endpoint, intake }, agentless = true) {
    this._interval = interval || 1000 // 1s
    this._timeout = timeout || 5000 // 5s
    this._eventType = eventType

    this._buffer = []
    this._bufferLimit = 1000
    this._bufferSize = 0

    this._config = config
    this._endpoint = endpoint
    this._intake = intake

    this._periodic = setInterval(() => {
      this.flush()
    }, this._interval).unref()

    this._beforeExitHandler = () => {
      this.destroy()
    }
    process.once('beforeExit', this._beforeExitHandler)

    // We only need uncaughtException since:
    // - unhandledRejection is for Promises and will eventually trigger uncaughtException if unhandled
    // - uncaughtExceptionMonitor is just for monitoring and doesn't prevent the exception
    this._uncaughtExceptionHandler = (error) => {
      this.flush(() => {
        throw error // Re-throw to preserve Node's default error handling
      })
    }
    process.once('uncaughtException', this._uncaughtExceptionHandler)

    this._destroyed = false
    this._agentless = agentless

    Object.defineProperty(this, '_url', {
      get () {
        return this._getUrl()
      }
    })

    logger.debug(`Started ${this.constructor.name} to ${this._url.href}`)
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

    log.debug(`Encoded LLMObs payload: ${payload}`)

    this._makeRequest(payload, events.length, _cb)
  }

  makePayload (events) {}

  destroy () {
    if (!this._destroyed) {
      logger.debug(`Stopping ${this.constructor.name}`)
      clearInterval(this._periodic)
      process.removeListener('beforeExit', this._beforeExitHandler)
      process.removeListener('uncaughtException', this._uncaughtExceptionHandler)
      this.flush()
      this._destroyed = true
    }
  }

  _makeRequest (payload, numEvents, cb = () => {}) {
    const options = this._getOptions()

    request(payload, options, (err, resp, code) => {
      if (err) {
        logger.error(
          'Error sending %d LLMObs %s events to %s: %s', numEvents, this._eventType, options.url, err.message, err
        )

        if (!this._agentless) {
          this._agentless = true

          logger.debug('Retrying LLM Observability with agentless enabled.')

          if (!this._config.apiKey) {
            throw new Error(
              'DD_API_KEY is required for sending LLMObs data when no agent is running.\n' +
              'Ensure either `DD_API_KEY` is set, or an agent is running.'
            )
          }

          logger.debug(`Restarting ${this.constructor.name} to ${this._url.href}`)

          this._makeRequest(payload, numEvents, cb)
          return
        }
      } else if (code >= 300) {
        logger.error(
          'Error sending %d LLMObs %s events to %s: %s', numEvents, this._eventType, options.url, code
        )
      } else {
        logger.debug(`Sent ${numEvents} LLMObs ${this._eventType} events to ${options.url}`)
      }

      cb(err, resp, code)
    })
  }

  _getOptions () {
    const options = {
      headers: {
        'Content-Type': 'application/json'
      },
      method: 'POST',
      timeout: this._timeout,
      url: this._url
    }

    if (this._agentless) {
      options.headers['DD-API-KEY'] = this._config.apiKey || ''
    } else {
      options.headers[EVP_SUBDOMAIN_HEADER_NAME] = this._intake
    }

    return options
  }

  _getUrl () {
    if (this._agentless) {
      return new URL(format({
        protocol: 'https:',
        hostname: `${this._intake}.${this._config.site}`,
        pathname: this._endpoint
      }))
    } else {
      const { hostname, port } = this._config
      const base = this._config.url || new URL(format({
        protocol: 'http:',
        hostname,
        port
      }))

      const proxyPath = path.join(EVP_PROXY_AGENT_BASE_PATH, this._endpoint)
      return new URL(proxyPath, base)
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

module.exports = BaseLLMObsWriter
