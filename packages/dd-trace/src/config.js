'use strict'

const fs = require('fs')
const os = require('os')
const URL = require('url').URL
const path = require('path')
const pkg = require('./pkg')
const coalesce = require('koalas')
const tagger = require('./tagger')
const { isTrue, isFalse } = require('./util')
const uuid = require('crypto-randomuuid')

const fromEntries = Object.fromEntries || (entries =>
  entries.reduce((obj, [k, v]) => Object.assign(obj, { [k]: v }), {}))

// eslint-disable-next-line max-len
const qsRegex = '((?i)(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?|access_?|secret_?)key(?:_?id)?|token|consumer_?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?)(?:(?:\\s|%20)*(?:=|%3D)[^&]+|(?:"|%22)(?:\\s|%20)*(?::|%3A)(?:\\s|%20)*(?:"|%22)(?:%2[^2]|%[^2]|[^"%])+(?:"|%22))|bearer(?:\\s|%20)+[a-z0-9\\._\\-]|token(?::|%3A)[a-z0-9]{13}|gh[opsu]_[0-9a-zA-Z]{36}|ey[I-L](?:[\\w=-]|%3D)+\\.ey[I-L](?:[\\w=-]|%3D)+(?:\\.(?:[\\w.+\\/=-]|%3D|%2F|%2B)+)?|[\\-]{5}BEGIN(?:[a-z\\s]|%20)+PRIVATE\\sKEY(?:\\s|%20)KEY[\\-]{5}[^\\-]+[\\-]{5}END(?:[a-z\\s]|%20)+PRIVATE\\sKEY(?:\\s|%20)KEY|ssh-rsa(?:\\s|%20)*(?:[a-z0-9\\/\\.+]|%2F|%5C|%2B){100,})'

class Config {
  constructor (options) {
    options = options || {}

    this.tags = {}

    tagger.add(this.tags, process.env.DD_TAGS)
    tagger.add(this.tags, process.env.DD_TRACE_TAGS)
    tagger.add(this.tags, process.env.DD_TRACE_GLOBAL_TAGS)
    tagger.add(this.tags, options.tags)

    const DD_TRACING_ENABLED = coalesce(
      process.env.DD_TRACING_ENABLED,
      true
    )
    const DD_PROFILING_ENABLED = coalesce(
      options.profiling, // TODO: remove when enabled by default
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
    const DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP = coalesce(
      options.queryStringObfuscation,
      process.env.DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP,
      qsRegex
    )
    const DD_RUNTIME_METRICS_ENABLED = coalesce(
      options.runtimeMetrics, // TODO: remove when enabled by default
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
    const DD_CIVISIBILITY_AGENTLESS_URL = process.env.DD_CIVISIBILITY_AGENTLESS_URL
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
      false
    )
    const DD_TRACE_TELEMETRY_ENABLED = coalesce(
      process.env.DD_TRACE_TELEMETRY_ENABLED,
      true
    )
    const DD_TRACE_DEBUG = coalesce(
      process.env.DD_TRACE_DEBUG,
      false
    )
    const DD_TRACE_AGENT_PROTOCOL_VERSION = coalesce(
      options.protocolVersion,
      process.env.DD_TRACE_AGENT_PROTOCOL_VERSION,
      '0.4'
    )
    const DD_TRACE_PARTIAL_FLUSH_MIN_SPANS = coalesce(
      parseInt(options.flushMinSpans),
      parseInt(process.env.DD_TRACE_PARTIAL_FLUSH_MIN_SPANS),
      1000
    )
    const DD_TRACE_B3_ENABLED = coalesce(
      options.experimental && options.experimental.b3,
      process.env.DD_TRACE_EXPERIMENTAL_B3_ENABLED,
      false
    )
    const DD_TRACE_TRACEPARENT_ENABLED = coalesce(
      options.experimental && options.experimental.traceparent,
      process.env.DD_TRACE_EXPERIMENTAL_TRACEPARENT_ENABLED,
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

    let appsec = options.appsec || (options.experimental && options.experimental.appsec)

    const DD_APPSEC_ENABLED = coalesce(
      appsec && (appsec === true || appsec.enabled === true), // TODO: remove when enabled by default
      process.env.DD_APPSEC_ENABLED,
      false
    )

    appsec = appsec || {}

    const DD_APPSEC_RULES = coalesce(
      appsec.rules,
      process.env.DD_APPSEC_RULES,
      path.join(__dirname, 'appsec', 'recommended.json')
    )
    const DD_APPSEC_TRACE_RATE_LIMIT = coalesce(
      parseInt(appsec.rateLimit),
      parseInt(process.env.DD_APPSEC_TRACE_RATE_LIMIT),
      100
    )
    const DD_APPSEC_WAF_TIMEOUT = coalesce(
      parseInt(appsec.wafTimeout),
      parseInt(process.env.DD_APPSEC_WAF_TIMEOUT),
      5e3 // µs
    )
    const DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP = coalesce(
      appsec.obfuscatorKeyRegex,
      process.env.DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP,
      `(?i)(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?)key)|token|consumer_?(?:id|key|se\
cret)|sign(?:ed|ature)|bearer|authorization`
    )
    const DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP = coalesce(
      appsec.obfuscatorValueRegex,
      process.env.DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP,
      `(?i)(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?|access_?|secret_?)key(?:_?id)?|to\
ken|consumer_?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?)(?:\\s*=[^;]|"\\s*:\\s*"[^"]+")|bearer\
\\s+[a-z0-9\\._\\-]+|token:[a-z0-9]{13}|gh[opsu]_[0-9a-zA-Z]{36}|ey[I-L][\\w=-]+\\.ey[I-L][\\w=-]+(?:\\.[\\w.+\\/=-]+)?\
|[\\-]{5}BEGIN[a-z\\s]+PRIVATE\\sKEY[\\-]{5}[^\\-]+[\\-]{5}END[a-z\\s]+PRIVATE\\sKEY|ssh-rsa\\s*[a-z0-9\\/\\.+]{100,}`
    )

    const sampler = (options.experimental && options.experimental.sampler) || {}
    const ingestion = options.ingestion || {}
    const dogstatsd = coalesce(options.dogstatsd, {})

    Object.assign(sampler, {
      sampleRate: coalesce(
        options.sampleRate,
        ingestion.sampleRate,
        sampler.sampleRate,
        process.env.DD_TRACE_SAMPLE_RATE
      ),
      rateLimit: coalesce(ingestion.rateLimit, sampler.rateLimit, process.env.DD_TRACE_RATE_LIMIT)
    })

    const inAWSLambda = process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined
    const defaultFlushInterval = inAWSLambda ? 0 : 2000

    this.tracing = !isFalse(DD_TRACING_ENABLED)
    this.debug = isTrue(DD_TRACE_DEBUG)
    this.logInjection = isTrue(DD_LOGS_INJECTION)
    this.queryStringObfuscation = DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP
    this.env = DD_ENV
    this.url = DD_CIVISIBILITY_AGENTLESS_URL ? new URL(DD_CIVISIBILITY_AGENTLESS_URL)
      : getAgentUrl(DD_TRACE_AGENT_URL, options)
    this.site = coalesce(options.site, process.env.DD_SITE, 'datadoghq.com')
    this.hostname = DD_AGENT_HOST || (this.url && this.url.hostname)
    this.port = String(DD_TRACE_AGENT_PORT || (this.url && this.url.port))
    this.flushInterval = coalesce(parseInt(options.flushInterval, 10), defaultFlushInterval)
    this.flushMinSpans = DD_TRACE_PARTIAL_FLUSH_MIN_SPANS
    this.sampleRate = coalesce(Math.min(Math.max(sampler.sampleRate, 0), 1), 1)
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
    this.experimental = {
      b3: isTrue(DD_TRACE_B3_ENABLED),
      traceparent: isTrue(DD_TRACE_TRACEPARENT_ENABLED),
      runtimeId: isTrue(DD_TRACE_RUNTIME_ID_ENABLED),
      exporter: DD_TRACE_EXPORTER,
      enableGetRumData: isTrue(DD_TRACE_GET_RUM_DATA_ENABLED),
      sampler
    }
    this.reportHostname = isTrue(coalesce(options.reportHostname, process.env.DD_TRACE_REPORT_HOSTNAME, false))
    this.scope = process.env.DD_TRACE_SCOPE
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
      enabled: isTrue(DD_APPSEC_ENABLED),
      rules: DD_APPSEC_RULES,
      rateLimit: DD_APPSEC_TRACE_RATE_LIMIT,
      wafTimeout: DD_APPSEC_WAF_TIMEOUT,
      obfuscatorKeyRegex: DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP,
      obfuscatorValueRegex: DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP
    }

    tagger.add(this.tags, {
      service: this.service,
      env: this.env,
      version: this.version,
      'runtime-id': uuid()
    })
  }
}

function getAgentUrl (url, options) {
  if (url) return new URL(url)

  if (os.type() === 'Windows_NT') return

  if (
    !options.hostname &&
    !options.port &&
    !process.env.DD_AGENT_HOST &&
    !process.env.DD_TRACE_AGENT_HOSTNAME &&
    !process.env.DD_TRACE_AGENT_PORT &&
    fs.existsSync('/var/run/datadog/apm.socket')
  ) {
    return new URL('unix:///var/run/datadog/apm.socket')
  }
}

module.exports = Config
