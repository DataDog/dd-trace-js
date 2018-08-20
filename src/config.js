'use strict'

const URL = require('url-parse')
const platform = require('./platform')
const coalesce = require('koalas')

class Config {
  constructor (options) {
    options = options || {}

    const enabled = coalesce(options.enabled, platform.env('DD_TRACE_ENABLED'), true)
    const debug = coalesce(options.debug, platform.env('DD_TRACE_DEBUG'), false)
    const env = coalesce(options.env, platform.env('DD_ENV'))
    const protocol = 'http'
    const hostname = coalesce(options.hostname, platform.env('DD_TRACE_AGENT_HOSTNAME'), 'localhost')
    const port = coalesce(options.port, platform.env('DD_TRACE_AGENT_PORT'), 8126)
    const sampleRate = coalesce(Math.min(Math.max(options.sampleRate, 0), 1), 1)
    const flushInterval = coalesce(parseInt(options.flushInterval, 10), 2000)
    const plugins = coalesce(options.plugins, true)

    this.enabled = String(enabled) === 'true'
    this.debug = String(debug) === 'true'
    this.env = env
    this.url = new URL(`${protocol}://${hostname}:${port}`)
    this.tags = Object.assign({}, options.tags)
    this.flushInterval = flushInterval
    this.bufferSize = 100000
    this.sampleRate = sampleRate
    this.logger = options.logger
    this.plugins = !!plugins

    Object.defineProperty(this, 'service', {
      get () {
        const service = coalesce(options.service, platform.env('DD_SERVICE_NAME'))

        if (service) {
          return service
        }

        return platform.service() || 'node'
      }
    })
  }
}

module.exports = Config
