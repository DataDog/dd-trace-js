'use strict'

const EventEmitter = require('events')
const URL = require('url-parse')
const pkg = require('./pkg')
const coalesce = require('koalas')
const scopes = require('../../../ext/scopes')
const tagger = require('./tagger')
const id = require('./id')
const { isTrue, isFalse } = require('./util')

const runtimeId = `${id().toString()}${id().toString()}`

function pluginEnv (name) {
  return process.env[`DD_TRACE_${name.toUpperCase()}`.replace(/[^a-z0-9_]/ig, '_')]
}

class Config extends EventEmitter {
  constructor (options) {
    super()
    this._hasEmitted = {}
    this.configure(options)
  }

  reset () {
    for (const prop of Reflect.ownKeys(this)) {
      delete this[prop]
    }
    EventEmitter.call(this)
    this._hasEmitted = {}
    this.configure()
  }

  configurePlugin (name, config = {}) {
    this.pluginConfigs = this.pluginConfigs || {}

    if (!name) {
      return
    }

    if (typeof config === 'boolean') {
      config = { enabled: config }
    }

    const enabled = pluginEnv(`${name}_ENABLED`)
    if (enabled !== undefined) {
      config.enabled = isTrue(enabled)
    }

    const analyticsEnabled = pluginEnv(`${name}_ANALYTICS_ENABLED`)
    const analyticsSampleRate = Math.min(Math.max(pluginEnv(`${name}_ANALYTICS_SAMPLE_RATE`), 0), 1)

    if (isFalse(analyticsEnabled)) {
      config.analytics = false
    } else if (!Number.isNaN(analyticsSampleRate)) {
      config.analytics = analyticsSampleRate
    } else if (isTrue(analyticsEnabled)) {
      config.analytics = true
    }

    this.pluginConfigs[name] = Object.assign(this.pluginConfigs[name] || {}, config)

    this.retroEmit(`update.plugin.${name}`) // TODO this is not needed while the instrumenter managers plugin state
    this.retroEmit('update.plugins')
  }

  retroOn (name, handler) {
    if (this._hasEmitted[name]) {
      handler(this)
    }
    this.on(name, handler)
  }

  retroEmit (name) {
    if (!this._hasEmitted[name]) {
      this._hasEmitted[name] = true
    }
    return this.emit(name, this)
  }

  _getExperimental (options, prop) {
    if (options.experimental && prop in options.experimental) {
      return options.experimental[prop]
    }

    if (this.experimental && prop in this.experimental) {
      return this.experimental[prop]
    }
  }

  configure (options) {
    options = options || {}

    this.tags = this.tags || {}

    if (!this.hasInitialized) {
      tagger.add(this.tags, process.env.DD_TAGS)
      tagger.add(this.tags, process.env.DD_TRACE_TAGS)
      tagger.add(this.tags, process.env.DD_TRACE_GLOBAL_TAGS)
    }
    tagger.add(this.tags, options.tags)

    const DD_TRACE_ANALYTICS_ENABLED = coalesce(
      options.analytics,
      this.analytics,
      process.env.DD_TRACE_ANALYTICS_ENABLED,
      process.env.DD_TRACE_ANALYTICS,
      false
    )
    // Temporary disabled
    const DD_PROFILING_ENABLED = coalesce(
      // options.profiling,
      // process.env.DD_PROFILING_ENABLED,
      this.profiling,
      process.env.DD_EXPERIMENTAL_PROFILING_ENABLED,
      false
    )
    const DD_PROFILING_EXPORTERS = coalesce(
      this.profiling && this.profiling.exporters,
      process.env.DD_PROFILING_EXPORTERS,
      'agent'
    )
    const DD_PROFILING_SOURCE_MAP = coalesce(
      this.profiling && this.profiling.sourceMap,
      process.env.DD_PROFILING_SOURCE_MAP
    )
    const DD_LOGS_INJECTION = coalesce(
      options.logInjection,
      this.logInjection,
      process.env.DD_LOGS_INJECTION,
      false
    )
    const DD_RUNTIME_METRICS_ENABLED = coalesce(
      options.runtimeMetrics,
      this.runtimeMetrics,
      process.env.DD_RUNTIME_METRICS_ENABLED,
      false
    )
    const DD_AGENT_HOST = coalesce(
      options.hostname,
      this.hostname,
      process.env.DD_AGENT_HOST,
      process.env.DD_TRACE_AGENT_HOSTNAME,
      '127.0.0.1'
    )
    const DD_TRACE_AGENT_PORT = coalesce(
      options.port,
      this.port,
      process.env.DD_TRACE_AGENT_PORT,
     '8126'
    )
    const DD_TRACE_AGENT_URL = coalesce(
      options.url,
      this.url,
      process.env.DD_TRACE_AGENT_URL,
      process.env.DD_TRACE_URL,
      null
    )
    const DD_SERVICE = options.service ||
      process.env.DD_SERVICE ||
      process.env.DD_SERVICE_NAME ||
      this.tags.service ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      pkg.name ||
      'node'
    const DD_ENV = coalesce(
      options.env,
      process.env.DD_ENV,
      this.tags.env
    )
    const DD_VERSION = coalesce(
      options.version,
      process.env.DD_VERSION,
      this.tags.version,
      pkg.version
    )
    const DD_TRACE_STARTUP_LOGS = coalesce(
      options.startupLogs,
      this.startupLogs,
      process.env.DD_TRACE_STARTUP_LOGS,
      true
    )
    const DD_TRACE_ENABLED = coalesce(
      options.enabled,
      this.enabled,
      process.env.DD_TRACE_ENABLED,
      true
    )
    const DD_TRACE_DEBUG = coalesce(
      options.debug,
      this.debug,
      process.env.DD_TRACE_DEBUG,
      false
    )
    const DD_TRACE_AGENT_PROTOCOL_VERSION = coalesce(
      options.protocolVersion,
      this.protocolVersion,
      process.env.DD_TRACE_AGENT_PROTOCOL_VERSION,
      '0.4'
    )

    const sampler = this._getExperimental(options, 'sampler') || {}
    const ingestion = options.ingestion || {}
    const dogstatsd = coalesce(options.dogstatsd, this.dogstatsd, {})

    Object.assign(sampler, {
      sampleRate: coalesce(ingestion.sampleRate, sampler.sampleRate, process.env.DD_TRACE_SAMPLE_RATE),
      rateLimit: coalesce(ingestion.rateLimit, sampler.rateLimit, process.env.DD_TRACE_RATE_LIMIT)
    })

    this.enabled = isTrue(DD_TRACE_ENABLED)
    this.debug = isTrue(DD_TRACE_DEBUG)
    this.logInjection = isTrue(DD_LOGS_INJECTION)
    this.env = DD_ENV
    this.url = DD_TRACE_AGENT_URL && new URL(DD_TRACE_AGENT_URL)
    this.site = coalesce(options.site, this.site, process.env.DD_SITE, 'datadoghq.com')
    this.hostname = DD_AGENT_HOST || (this.url && this.url.hostname)
    this.port = String(DD_TRACE_AGENT_PORT || (this.url && this.url.port))
    if (!this.url || (!process.env.DD_TRACE_AGENT_URL && !options.url)) {
      this.url = new URL(`${this.url ? this.url.protocol : 'http:'}//${this.hostname}:${this.port}`)
    }
    this.flushInterval = coalesce(parseInt(options.flushInterval, 10), this.flushInterval, 2000)
    this.sampleRate = coalesce(Math.min(Math.max(options.sampleRate, 0), 1), this.sampleRate, 1)
    this.logger = options.logger
    this.plugins = !!coalesce(options.plugins, this.plugins, true)
    this.service = DD_SERVICE
    this.version = DD_VERSION
    this.analytics = isTrue(DD_TRACE_ANALYTICS_ENABLED)
    this.dogstatsd = this.dogstatsd || {}
    this.dogstatsd = {
      hostname: coalesce(dogstatsd.hostname, process.env.DD_DOGSTATSD_HOSTNAME, this.hostname),
      port: String(coalesce(dogstatsd.port, process.env.DD_DOGSTATSD_PORT, 8125))
    }
    this.runtimeMetrics = isTrue(DD_RUNTIME_METRICS_ENABLED)
    this.trackAsyncScope = coalesce(options.trackAsyncScope, this.trackAsyncScope) !== false
    this.experimental = {
      b3: !!this._getExperimental(options, 'b3'),
      runtimeId: !!this._getExperimental(options, 'runtimeId'),
      exporter: this._getExperimental(options, 'exporter'),
      enableGetRumData: !!this._getExperimental(options, 'getRumData'),
      sampler,
      internalErrors: this._getExperimental(options, 'internalErrors')
    }
    this.reportHostname = isTrue(coalesce(
      options.reportHostname,
      this.reportHostname,
      process.env.DD_TRACE_REPORT_HOSTNAME,
      false
    ))
    this.scope = isFalse(process.env.DD_CONTEXT_PROPAGATION)
      ? scopes.NOOP
      : coalesce(options.scope, this.scope, process.env.DD_TRACE_SCOPE)
    this.logLevel = coalesce(
      options.logLevel,
      this.logLevel,
      process.env.DD_TRACE_LOG_LEVEL,
      'debug'
    )
    this.profiling = {
      enabled: isTrue(DD_PROFILING_ENABLED),
      sourceMap: !isFalse(DD_PROFILING_SOURCE_MAP),
      exporters: DD_PROFILING_EXPORTERS
    }
    this.lookup = coalesce(options.lookup, this.lookup)
    this.startupLogs = isTrue(DD_TRACE_STARTUP_LOGS)
    this.protocolVersion = DD_TRACE_AGENT_PROTOCOL_VERSION

    tagger.add(this.tags, { service: this.service, env: this.env, version: this.version })

    if (this.experimental.runtimeId) {
      tagger.add(this.tags, {
        'runtime-id': runtimeId
      })
    }

    if (!this.hasInitialized) {
      this.hasInitialized = true
    }

    this.retroEmit('update')
  }
}

module.exports = new Config()
