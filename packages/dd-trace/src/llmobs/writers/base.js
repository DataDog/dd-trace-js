'use strict'

const request = require('../../exporters/common/request')
const { URL, format } = require('node:url')
const path = require('node:path')

const logger = require('../../log')

const { encodeUnicode } = require('../util')
const telemetry = require('../telemetry')
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

  get url () {
    if (this._agentless == null) return null

    const baseUrl = this._baseUrl.href
    const endpoint = this._endpoint

    // Split on protocol separator to preserve it
    // path.join will remove some slashes unnecessarily
    const [protocol, rest] = baseUrl.split('://')
    return protocol + '://' + path.join(rest, endpoint)
  }

  append (event, byteLength) {
    if (this._buffer.length >= this._bufferLimit) {
      logger.warn(`${this.constructor.name} event buffer full (limit is ${this._bufferLimit}), dropping event`)
      telemetry.recordDroppedPayload(1, this._eventType, 'buffer_full')
      return
    }

    this._bufferSize += byteLength || Buffer.byteLength(JSON.stringify(event))
    this._buffer.push(event)
  }

  flush () {
    const noAgentStrategy = this._agentless == null

    if (this._buffer.length === 0 || noAgentStrategy) {
      return
    }

    const events = this._buffer
    this._buffer = []
    this._bufferSize = 0
    const payload = this._encode(this.makePayload(events))

    log.debug('Encoded LLMObs payload: %s', payload)

    const options = this._getOptions()

    request(payload, options, (err, resp, code) => {
      parseResponseAndLog(err, code, events.length, this.url, this._eventType)
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
    const { url, endpoint } = this._getUrlAndPath()

    this._baseUrl = url
    this._endpoint = endpoint

    logger.debug(`Configuring ${this.constructor.name} to ${this.url}`)
  }

  _getUrlAndPath () {
    if (this._agentless) {
      return {
        url: new URL(format({
          protocol: 'https:',
          hostname: `${this._intake}.${this._config.site}`
        })),
        endpoint: this._endpoint
      }
    }

    const { hostname, port } = this._config
    const base = this._config.url || new URL(format({
      protocol: 'http:',
      hostname,
      port
    }))

    return {
      url: base,
      endpoint: path.join(EVP_PROXY_AGENT_BASE_PATH, this._endpoint)
    }
  }

  _getOptions () {
    const options = {
      headers: {
        'Content-Type': 'application/json'
      },
      method: 'POST',
      timeout: this._timeout,
      url: this._baseUrl,
      path: this._endpoint
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
    }).replaceAll(String.raw`\\u`, String.raw`\u`) // remove double escaping
  }
}

module.exports = BaseLLMObsWriter
