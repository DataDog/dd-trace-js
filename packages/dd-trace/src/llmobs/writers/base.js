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
const { parseResponseAndLog } = require('./util')

class BaseLLMObsWriter {
  constructor ({ interval, timeout, eventType, config, endpoint, intake }) {
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

    this._destroyed = false
  }

  get _url () {
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

  append (event, byteLength) {
    if (this._buffer.length >= this._bufferLimit) {
      logger.warn(`${this.constructor.name} event buffer full (limit is ${this._bufferLimit}), dropping event`)
      return
    }

    this._bufferSize += byteLength || Buffer.from(JSON.stringify(event)).byteLength
    this._buffer.push(event)
  }

  flush () {
    if (
      this._buffer.length === 0 ||
      this._agentless == null
    ) {
      return
    }

    const events = this._buffer
    this._buffer = []
    this._bufferSize = 0
    const payload = this._encode(this.makePayload(events))

    log.debug(`Encoded LLMObs payload: ${payload}`)

    const options = this._getOptions()

    request(payload, options, (err, resp, code) => {
      parseResponseAndLog(err, code, events.length, options.url.href, this._eventType)
    })
  }

  makePayload (events) {}

  destroy () {
    if (!this._destroyed) {
      logger.debug(`Stopping ${this.constructor.name}`)
      clearInterval(this._periodic)
      process.removeListener('beforeExit', this._beforeExitHandler)
      this.flush()
      this._destroyed = true
    }
  }

  setAgentless (agentless) {
    this._agentless = agentless
    logger.debug(`Started ${this.constructor.name} to ${this._url.href}`)
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
