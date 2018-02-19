'use strict'

const URL = require('url-parse')
const platform = require('./platform')
const coalesce = require('koalas')

class Config {
  constructor (options) {
    options = options || {}

    const enabled = coalesce(options.enabled, platform.env('DATADOG_TRACE_ENABLED'), true)
    const debug = coalesce(options.debug, platform.env('DATADOG_TRACE_DEBUG'), false)
    const protocol = 'http'
    const hostname = coalesce(options.hostname, platform.env('DATADOG_TRACE_AGENT_HOSTNAME'), 'localhost')
    const port = coalesce(options.port, platform.env('DATADOG_TRACE_AGENT_PORT'), 8126)

    this.enabled = String(enabled) === 'true'
    this.debug = String(debug) === 'true'
    this.service = coalesce(options.service, platform.env('DATADOG_SERVICE_NAME'))
    this.env = coalesce(options.env, platform.env('DATADOG_ENV'))
    this.url = new URL(`${protocol}://${hostname}:${port}`)
    this.tags = coalesce(options.tags, {})
    this.flushInterval = 2000
    this.bufferSize = 1000
    this.sampleRate = 1
    this.logger = options.logger
  }
}

module.exports = Config
