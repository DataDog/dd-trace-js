'use strict'

const URL = require('url-parse')
const platform = require('./platform')
const coalesce = require('koalas')
const scopes = require('../../../ext/scopes')
const exporters = require('../../../ext/exporters')

class Config {
  constructor (service, options) {
    options = options || {}

    const enabled = coalesce(options.enabled, platform.env('DD_TRACE_ENABLED'), true)
    const debug = coalesce(options.debug, platform.env('DD_TRACE_DEBUG'), false)
    const logInjection = coalesce(options.logInjection, platform.env('DD_LOGS_INJECTION'), false)
    const env = coalesce(options.env, platform.env('DD_ENV'))
    const url = coalesce(options.url, platform.env('DD_TRACE_AGENT_URL'), null)
    const protocol = 'http'
    const hostname = coalesce(
      options.hostname,
      platform.env('DD_AGENT_HOST'),
      platform.env('DD_TRACE_AGENT_HOSTNAME')
    )
    const port = coalesce(options.port, platform.env('DD_TRACE_AGENT_PORT'), 8126)
    const sampleRate = coalesce(Math.min(Math.max(options.sampleRate, 0), 1), 1)
    const flushInterval = coalesce(parseInt(options.flushInterval, 10), 2000)
    const plugins = coalesce(options.plugins, true)
    const dogstatsd = options.dogstatsd || {}
    const runtimeMetrics = coalesce(options.runtimeMetrics, platform.env('DD_RUNTIME_METRICS_ENABLED'), false)
    const analytics = coalesce(
      options.analytics,
      platform.env('DD_TRACE_ANALYTICS_ENABLED'),
      platform.env('DD_TRACE_ANALYTICS')
    )
    const reportHostname = coalesce(options.reportHostname, platform.env('DD_TRACE_REPORT_HOSTNAME'), false)
    const scope = coalesce(options.scope, platform.env('DD_TRACE_SCOPE'))

    this.enabled = String(enabled) === 'true'
    this.debug = String(debug) === 'true'
    this.logInjection = String(logInjection) === 'true'
    this.env = env
    this.url = url ? new URL(url) : new URL(`${protocol}://${hostname || 'localhost'}:${port}`)
    this.hostname = hostname || this.url.hostname
    this.flushInterval = flushInterval
    this.sampleRate = sampleRate
    this.logger = options.logger
    this.plugins = !!plugins
    this.service = coalesce(options.service, platform.env('DD_SERVICE_NAME'), service, 'node')
    this.analytics = String(analytics) === 'true'
    this.tags = Object.assign({}, options.tags)
    this.dogstatsd = {
      port: String(coalesce(dogstatsd.port, platform.env('DD_DOGSTATSD_PORT'), 8125))
    }
    this.runtimeMetrics = String(runtimeMetrics) === 'true'
    this.experimental = {
      b3: !(!options.experimental || !options.experimental.b3),
      exporter: (options.experimental && options.experimental.exporter === exporters.LOG)
        ? exporters.LOG
        : exporters.AGENT,
      thenables: !(!options.experimental || !options.experimental.thenables)
    }
    this.reportHostname = String(reportHostname) === 'true'
    this.scope = process.env.DD_CONTEXT_PROPAGATION === 'false' ? scopes.NOOP : scope
  }
}

module.exports = Config
