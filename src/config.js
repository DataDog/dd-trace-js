'use strict'

const URL = require('url-parse')
const platform = require('./platform')
const coalesce = require('koalas')

class Config {
  constructor (service, options) {
    options = typeof service === 'object' ? service : options || {}

    const enabled = coalesce(options.enabled, platform.env('DD_TRACE_ENABLED'), true)
    const debug = coalesce(options.debug, platform.env('DD_TRACE_DEBUG'), false)
    const logInjection = coalesce(options.logInjection, platform.env('DD_LOGS_INJECTION'), false)
    const env = coalesce(options.env, platform.env('DD_ENV'))
    const url = coalesce(options.url, platform.env('DD_TRACE_AGENT_URL'), null)
    const protocol = 'http'
    const hostname = coalesce(
      options.hostname,
      platform.env('DD_AGENT_HOST'),
      platform.env('DD_TRACE_AGENT_HOSTNAME'),
      'localhost'
    )
    const port = coalesce(options.port, platform.env('DD_TRACE_AGENT_PORT'), 8126)
    const sampleRate = coalesce(Math.min(Math.max(options.sampleRate, 0), 1), 1)
    const flushInterval = coalesce(parseInt(options.flushInterval, 10), 2000)
    const plugins = coalesce(options.plugins, true)
    const analytics = coalesce(options.analytics, platform.env('DD_TRACE_ANALYTICS'))

    this.enabled = String(enabled) === 'true'
    this.debug = String(debug) === 'true'
    this.logInjection = String(logInjection) === 'true'
    this.env = env
    this.url = url ? new URL(url) : new URL(`${protocol}://${hostname}:${port}`)
    this.tags = Object.assign({}, options.tags)
    this.flushInterval = flushInterval
    this.bufferSize = 100000
    this.sampleRate = sampleRate
    this.logger = options.logger
    this.plugins = !!plugins
    this.service = coalesce(options.service, platform.env('DD_SERVICE_NAME'), service, 'node')
    this.analytics = String(analytics) === 'true'
  }
}

module.exports = Config
