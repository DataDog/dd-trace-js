'use strict'

const URL = require('url').URL
const pkg = require('./pkg')
const coalesce = require('koalas')
const scopes = require('../../../ext/scopes')
const tagger = require('./tagger')
const { isTrue, isFalse } = require('./util')
const uuid = require('crypto-randomuuid')

const fromEntries = Object.fromEntries || (entries =>
  entries.reduce((obj, [k, v]) => Object.assign(obj, { [k]: v }), {}))

class Config {
  constructor (options) {
    options = options || {}

    this.tags = {}

    tagger.add(this.tags, process.env.DD_TAGS)
    tagger.add(this.tags, process.env.DD_TRACE_TAGS)
    tagger.add(this.tags, process.env.DD_TRACE_GLOBAL_TAGS)
    tagger.add(this.tags, options.tags)

    // Temporary disabled
    const DD_PROFILING_ENABLED = coalesce(
      options.profiling,
      process.env.DD_EXPERIMENTAL_PROFILING_ENABLED,
      process.env.DD_PROFILING_ENABLED,
      false
    )
    const DD_PROFILING_EXPORTERS = coalesce(
      process.env.DD_PROFILING_EXPORTERS,
      'agent'
    )
    const DD_PROFILING_SOURCE_MAP = process.env.DD_PROFILING_SOURCE_MAP
    const DD_LOGS_INJECTION = coalesce(
      options.logInjection,
      process.env.DD_LOGS_INJECTION,
      false
    )
    const DD_RUNTIME_METRICS_ENABLED = coalesce(
      options.runtimeMetrics,
      process.env.DD_RUNTIME_METRICS_ENABLED,
      false
    )
    const DD_AGENT_HOST = coalesce(
      options.hostname,
      process.env.DD_AGENT_HOST,
      process.env.DD_TRACE_AGENT_HOSTNAME,
      '127.0.0.1'
    )
    const DD_TRACE_AGENT_PORT = coalesce(
      options.port,
      process.env.DD_TRACE_AGENT_PORT,
      '8126'
    )
    const DD_TRACE_AGENT_URL = coalesce(
      options.url,
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
    const DD_SERVICE_MAPPING = process.env.DD_SERVICE_MAPPING || ''
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
      process.env.DD_TRACE_STARTUP_LOGS,
      true
    )
    const DD_TRACE_TELEMETRY_ENABLED = coalesce(
      process.env.DD_TRACE_TELEMETRY_ENABLED,
      true
    )
    const DD_TRACE_ENABLED = coalesce(
      options.enabled,
      process.env.DD_TRACE_ENABLED,
      true
    )
    const DD_TRACE_DEBUG = coalesce(
      options.debug,
      process.env.DD_TRACE_DEBUG,
      false
    )
    const DD_TRACE_AGENT_PROTOCOL_VERSION = coalesce(
      options.protocolVersion,
      process.env.DD_TRACE_AGENT_PROTOCOL_VERSION,
      '0.4'
    )
    const DD_TRACE_B3_ENABLED = coalesce(
      options.experimental && options.experimental.b3,
      process.env.DD_TRACE_EXPERIMENTAL_B3_ENABLED,
      false
    )
    const DD_TRACE_RUNTIME_ID_ENABLED = coalesce(
      options.experimental && options.experimental.runtimeId,
      process.env.DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED,
      false
    )
    const DD_TRACE_EXPORTER = coalesce(
      options.experimental && options.experimental.exporter,
      process.env.DD_TRACE_EXPERIMENTAL_EXPORTER
    )
    const DD_TRACE_GET_RUM_DATA_ENABLED = coalesce(
      options.experimental && options.experimental.enableGetRumData,
      process.env.DD_TRACE_EXPERIMENTAL_GET_RUM_DATA_ENABLED,
      false
    )
    const DD_TRACE_INTERNAL_ERRORS_ENABLED = coalesce(
      options.experimental && options.experimental.internalErrors,
      process.env.DD_TRACE_EXPERIMENTAL_INTERNAL_ERRORS_ENABLED,
      false
    )
    // TODO(simon-id): add documentation for appsec config when we release it in public beta
    const DD_APPSEC_ENABLED = coalesce(
      options.experimental && options.experimental.appsec,
      process.env.DD_EXPERIMENTAL_APPSEC_ENABLED,
      process.env.DD_APPSEC_ENABLED,
      false
    )

    const sampler = (options.experimental && options.experimental.sampler) || {}
    const ingestion = options.ingestion || {}
    const dogstatsd = coalesce(options.dogstatsd, {})

    Object.assign(sampler, {
      sampleRate: coalesce(ingestion.sampleRate, sampler.sampleRate, process.env.DD_TRACE_SAMPLE_RATE),
      rateLimit: coalesce(ingestion.rateLimit, sampler.rateLimit, process.env.DD_TRACE_RATE_LIMIT)
    })

    const inAWSLambda = process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined
    const defaultFlushInterval = inAWSLambda ? 0 : 2000

    this.enabled = isTrue(DD_TRACE_ENABLED)
    this.debug = isTrue(DD_TRACE_DEBUG)
    this.logInjection = isTrue(DD_LOGS_INJECTION)
    this.env = DD_ENV
    this.url = DD_TRACE_AGENT_URL && new URL(DD_TRACE_AGENT_URL)
    this.site = coalesce(options.site, process.env.DD_SITE, 'datadoghq.com')
    this.hostname = DD_AGENT_HOST || (this.url && this.url.hostname)
    this.port = String(DD_TRACE_AGENT_PORT || (this.url && this.url.port))
    this.flushInterval = coalesce(parseInt(options.flushInterval, 10), defaultFlushInterval)
    this.sampleRate = coalesce(Math.min(Math.max(options.sampleRate, 0), 1), 1)
    this.logger = options.logger
    this.plugins = !!coalesce(options.plugins, true)
    this.service = DD_SERVICE
    this.serviceMapping = DD_SERVICE_MAPPING.length ? fromEntries(
      DD_SERVICE_MAPPING.split(',').map(x => x.trim().split(':'))
    ) : {}
    this.version = DD_VERSION
    this.dogstatsd = {
      hostname: coalesce(dogstatsd.hostname, process.env.DD_DOGSTATSD_HOSTNAME, this.hostname),
      port: String(coalesce(dogstatsd.port, process.env.DD_DOGSTATSD_PORT, 8125))
    }
    this.runtimeMetrics = isTrue(DD_RUNTIME_METRICS_ENABLED)
    this.trackAsyncScope = options.trackAsyncScope !== false
    this.experimental = {
      b3: isTrue(DD_TRACE_B3_ENABLED),
      runtimeId: isTrue(DD_TRACE_RUNTIME_ID_ENABLED),
      exporter: DD_TRACE_EXPORTER,
      enableGetRumData: isTrue(DD_TRACE_GET_RUM_DATA_ENABLED),
      sampler,
      internalErrors: isTrue(DD_TRACE_INTERNAL_ERRORS_ENABLED)
    }
    this.reportHostname = isTrue(coalesce(options.reportHostname, process.env.DD_TRACE_REPORT_HOSTNAME, false))
    this.scope = isFalse(process.env.DD_CONTEXT_PROPAGATION)
      ? scopes.NOOP
      : coalesce(options.scope, process.env.DD_TRACE_SCOPE)
    this.logLevel = coalesce(
      options.logLevel,
      process.env.DD_TRACE_LOG_LEVEL,
      'debug'
    )
    this.profiling = {
      enabled: isTrue(DD_PROFILING_ENABLED),
      sourceMap: !isFalse(DD_PROFILING_SOURCE_MAP),
      exporters: DD_PROFILING_EXPORTERS
    }
    this.lookup = options.lookup
    this.startupLogs = isTrue(DD_TRACE_STARTUP_LOGS)
    this.telemetryEnabled = isTrue(DD_TRACE_TELEMETRY_ENABLED)
    this.protocolVersion = DD_TRACE_AGENT_PROTOCOL_VERSION
    this.appsec = {
      enabled: isTrue(DD_APPSEC_ENABLED)
    }

    tagger.add(this.tags, {
      service: this.service,
      env: this.env,
      version: this.version,
      'runtime-id': uuid()
    })
  }
}

module.exports = Config
