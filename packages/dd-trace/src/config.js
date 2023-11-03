'use strict'

const fs = require('fs')
const os = require('os')
const uuid = require('crypto-randomuuid')
const URL = require('url').URL
const log = require('./log')
const pkg = require('./pkg')
const coalesce = require('koalas')
const tagger = require('./tagger')
const { isTrue, isFalse } = require('./util')
const { GIT_REPOSITORY_URL, GIT_COMMIT_SHA } = require('./plugins/util/tags')
const { getGitMetadataFromGitProperties } = require('./git_properties')
const { updateConfig } = require('./telemetry')
const { getIsGCPFunction, getIsAzureFunctionConsumptionPlan } = require('./serverless')

const fromEntries = Object.fromEntries || (entries =>
  entries.reduce((obj, [k, v]) => Object.assign(obj, { [k]: v }), {}))

// eslint-disable-next-line max-len
const qsRegex = '(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?|access_?|secret_?)key(?:_?id)?|token|consumer_?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?)(?:(?:\\s|%20)*(?:=|%3D)[^&]+|(?:"|%22)(?:\\s|%20)*(?::|%3A)(?:\\s|%20)*(?:"|%22)(?:%2[^2]|%[^2]|[^"%])+(?:"|%22))|bearer(?:\\s|%20)+[a-z0-9\\._\\-]+|token(?::|%3A)[a-z0-9]{13}|gh[opsu]_[0-9a-zA-Z]{36}|ey[I-L](?:[\\w=-]|%3D)+\\.ey[I-L](?:[\\w=-]|%3D)+(?:\\.(?:[\\w.+\\/=-]|%3D|%2F|%2B)+)?|[\\-]{5}BEGIN(?:[a-z\\s]|%20)+PRIVATE(?:\\s|%20)KEY[\\-]{5}[^\\-]+[\\-]{5}END(?:[a-z\\s]|%20)+PRIVATE(?:\\s|%20)KEY|ssh-rsa(?:\\s|%20)*(?:[a-z0-9\\/\\.+]|%2F|%5C|%2B){100,}'
const defaultObfuscatorKeyRegex = `(?i)(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?\
|public_?)key)|token|consumer_?(?:id|key|secret)|sign(?:ed|ature)|bearer|authorization`
const defaultObfuscatorValueRegex = `(?i)(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?|\
  access_?|secret_?)key(?:_?id)?|to\
ken|consumer_?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?)(?:\\s*=[^;]|"\\s*:\\s*"[^"]+")|bearer\
\\s+[a-z0-9\\._\\-]+|token:[a-z0-9]{13}|gh[opsu]_[0-9a-zA-Z]{36}|ey[I-L][\\w=-]+\\.ey[I-L][\\w=-]+(?:\\.[\\w.+\\/=-]+)?\
|[\\-]{5}BEGIN[a-z\\s]+PRIVATE\\sKEY[\\-]{5}[^\\-]+[\\-]{5}END[a-z\\s]+PRIVATE\\sKEY|ssh-rsa\\s*[a-z0-9\\/\\.+]{100,}`
const defaultIastRequestSampling = 30

let defaultFlushInterval

function maybeFile (filepath) {
  if (!filepath) return
  try {
    return fs.readFileSync(filepath, 'utf8')
  } catch (e) {
    log.error(e)
    return undefined
  }
}

function safeJsonParse (input) {
  try {
    return JSON.parse(input)
  } catch (err) {
    return undefined
  }
}

const namingVersions = ['v0', 'v1']
const defaultNamingVersion = 'v0'

function validateNamingVersion (versionString) {
  if (!versionString) {
    return defaultNamingVersion
  }
  if (!namingVersions.includes(versionString)) {
    log.warn(
      `Unexpected input for config.spanAttributeSchema, picked default ${defaultNamingVersion}`
    )
    return defaultNamingVersion
  }
  return versionString
}

// Shallow clone with property name remapping
function remapify (input, mappings) {
  if (!input) return
  const output = {}
  for (const [key, value] of Object.entries(input)) {
    output[key in mappings ? mappings[key] : key] = value
  }
  return output
}

function propagationStyle (key, option, defaultValue) {
  // Extract by key if in object-form value
  if (typeof option === 'object' && !Array.isArray(option)) {
    option = option[key]
  }

  // Should be an array at this point
  if (Array.isArray(option)) return ['code', option.map(v => v.toLowerCase())]

  // If it's not an array but not undefined there's something wrong with the input
  if (typeof option !== 'undefined') {
    log.warn('Unexpected input for config.tracePropagationStyle')
  }

  // Otherwise, fallback to env var parsing
  const envKey = `DD_TRACE_PROPAGATION_STYLE_${key.toUpperCase()}`
  const envVar = coalesce(process.env[envKey], process.env.DD_TRACE_PROPAGATION_STYLE)
  if (typeof envVar !== 'undefined') {
    return ['env_var', envVar.split(',')
      .filter(v => v !== '')
      .map(v => v.trim().toLowerCase())]
  }

  return ['default', defaultValue]
}

class Config {
  constructor (options) {
    options = options || {}

    // Configure the logger first so it can be used to warn about other configs
    this.debug = isTrue(coalesce(
      process.env.DD_TRACE_DEBUG,
      false
    ))
    this.logger = options.logger
    this.logLevel = coalesce(
      options.logLevel,
      process.env.DD_TRACE_LOG_LEVEL,
      'debug'
    )

    log.use(this.logger)
    log.toggle(this.debug, this.logLevel, this)

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
    const DD_RUNTIME_METRICS_ENABLED = coalesce(
      options.runtimeMetrics, // TODO: remove when enabled by default
      process.env.DD_RUNTIME_METRICS_ENABLED,
      false
    )
    const DD_DBM_PROPAGATION_MODE = coalesce(
      options.dbmPropagationMode,
      process.env.DD_DBM_PROPAGATION_MODE,
      'disabled'
    )
    const DD_DATA_STREAMS_ENABLED = coalesce(
      options.dsmEnabled,
      process.env.DD_DATA_STREAMS_ENABLED,
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
    const DD_IS_CIVISIBILITY = coalesce(
      options.isCiVisibility,
      false
    )
    const DD_CIVISIBILITY_AGENTLESS_URL = process.env.DD_CIVISIBILITY_AGENTLESS_URL

    const DD_CIVISIBILITY_ITR_ENABLED = coalesce(
      process.env.DD_CIVISIBILITY_ITR_ENABLED,
      true
    )

    const DD_CIVISIBILITY_MANUAL_API_ENABLED = coalesce(
      process.env.DD_CIVISIBILITY_MANUAL_API_ENABLED,
      false
    )

    const DD_TRACE_MEMCACHED_COMMAND_ENABLED = coalesce(
      process.env.DD_TRACE_MEMCACHED_COMMAND_ENABLED,
      false
    )

    const DD_SERVICE = options.service ||
      process.env.DD_SERVICE ||
      process.env.DD_SERVICE_NAME ||
      this.tags.service ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.FUNCTION_NAME || // Google Cloud Function Name set by deprecated runtimes
      process.env.K_SERVICE || // Google Cloud Function Name set by newer runtimes
      process.env.WEBSITE_SITE_NAME || // set by Azure Functions
      pkg.name ||
      'node'
    const DD_SERVICE_MAPPING = coalesce(
      options.serviceMapping,
      process.env.DD_SERVICE_MAPPING ? fromEntries(
        process.env.DD_SERVICE_MAPPING.split(',').map(x => x.trim().split(':'))
      ) : {}
    )
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

    const DD_OPENAI_LOGS_ENABLED = coalesce(
      options.openAiLogsEnabled,
      process.env.DD_OPENAI_LOGS_ENABLED,
      false
    )

    const DD_API_KEY = coalesce(
      process.env.DATADOG_API_KEY,
      process.env.DD_API_KEY
    )

    const inAWSLambda = process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined

    const isGCPFunction = getIsGCPFunction()
    const isAzureFunctionConsumptionPlan = getIsAzureFunctionConsumptionPlan()

    const inServerlessEnvironment = inAWSLambda || isGCPFunction || isAzureFunctionConsumptionPlan

    const DD_TRACE_TELEMETRY_ENABLED = coalesce(
      process.env.DD_TRACE_TELEMETRY_ENABLED,
      !inServerlessEnvironment
    )
    const DD_TELEMETRY_HEARTBEAT_INTERVAL = process.env.DD_TELEMETRY_HEARTBEAT_INTERVAL
      ? Math.floor(parseFloat(process.env.DD_TELEMETRY_HEARTBEAT_INTERVAL) * 1000)
      : 60000
    const DD_OPENAI_SPAN_CHAR_LIMIT = process.env.DD_OPENAI_SPAN_CHAR_LIMIT
      ? parseInt(process.env.DD_OPENAI_SPAN_CHAR_LIMIT)
      : 128
    const DD_TELEMETRY_DEBUG = coalesce(
      process.env.DD_TELEMETRY_DEBUG,
      false
    )
    const DD_TELEMETRY_DEPENDENCY_COLLECTION_ENABLED = coalesce(
      process.env.DD_TELEMETRY_DEPENDENCY_COLLECTION_ENABLED,
      true
    )
    const DD_TELEMETRY_METRICS_ENABLED = coalesce(
      process.env.DD_TELEMETRY_METRICS_ENABLED,
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
    const DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP = coalesce(
      process.env.DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP,
      qsRegex
    )
    const DD_TRACE_CLIENT_IP_ENABLED = coalesce(
      options.clientIpEnabled,
      process.env.DD_TRACE_CLIENT_IP_ENABLED && isTrue(process.env.DD_TRACE_CLIENT_IP_ENABLED),
      false
    )
    const DD_TRACE_CLIENT_IP_HEADER = coalesce(
      options.clientIpHeader,
      process.env.DD_TRACE_CLIENT_IP_HEADER,
      null
    )
    // TODO: Remove the experimental env vars as a major?
    const DD_TRACE_B3_ENABLED = coalesce(
      options.experimental && options.experimental.b3,
      process.env.DD_TRACE_EXPERIMENTAL_B3_ENABLED,
      false
    )
    this.defaultPropagationStyle = ['datadog', 'tracecontext']
    if (isTrue(DD_TRACE_B3_ENABLED)) {
      this.defaultPropagationStyle.push('b3')
      this.defaultPropagationStyle.push('b3 single header')
    }
    if (process.env.DD_TRACE_PROPAGATION_STYLE && (
      process.env.DD_TRACE_PROPAGATION_STYLE_INJECT ||
      process.env.DD_TRACE_PROPAGATION_STYLE_EXTRACT
    )) {
      log.warn(
        'Use either the DD_TRACE_PROPAGATION_STYLE environment variable or separate ' +
        'DD_TRACE_PROPAGATION_STYLE_INJECT and DD_TRACE_PROPAGATION_STYLE_EXTRACT ' +
        'environment variables'
      )
    }
    this.propagationStyleInject = propagationStyle('inject', options.tracePropagationStyle,
      this.defaultPropagationStyle)
    console.log('PRO', this.propagationStyleInject)
    const DD_TRACE_PROPAGATION_STYLE_INJECT = this.propagationStyleInject[1]
    this.propagationStyleExtract = propagationStyle('extract', options.tracePropagationStyle,
      this.defaultPropagationStyle)
    const DD_TRACE_PROPAGATION_STYLE_EXTRACT = this.propagationStyleExtract[1]
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
    const DD_TRACE_SPAN_ATTRIBUTE_SCHEMA = validateNamingVersion(
      coalesce(
        options.spanAttributeSchema,
        process.env.DD_TRACE_SPAN_ATTRIBUTE_SCHEMA
      )
    )
    const DD_TRACE_PEER_SERVICE_MAPPING = coalesce(
      options.peerServiceMapping,
      process.env.DD_TRACE_PEER_SERVICE_MAPPING ? fromEntries(
        process.env.DD_TRACE_PEER_SERVICE_MAPPING.split(',').map(x => x.trim().split(':'))
      ) : {}
    )

    const peerServiceSet = (
      options.hasOwnProperty('spanComputePeerService') ||
      process.env.hasOwnProperty('DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED')
    )
    const peerServiceValue = coalesce(
      options.spanComputePeerService,
      process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED
    )

    const DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED = (
      DD_TRACE_SPAN_ATTRIBUTE_SCHEMA === 'v0'
        // In v0, peer service is computed only if it is explicitly set to true
        ? peerServiceSet && isTrue(peerServiceValue)
        // In >v0, peer service is false only if it is explicitly set to false
        : (peerServiceSet ? !isFalse(peerServiceValue) : true)
    )

    const DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED = coalesce(
      options.spanRemoveIntegrationFromService,
      isTrue(process.env.DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED)
    )
    const DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH = coalesce(
      process.env.DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH,
      '512'
    )

    const DD_TRACE_STATS_COMPUTATION_ENABLED = coalesce(
      options.stats,
      process.env.DD_TRACE_STATS_COMPUTATION_ENABLED,
      isGCPFunction || isAzureFunctionConsumptionPlan
    )

    const DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED = coalesce(
      options.traceId128BitGenerationEnabled,
      process.env.DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED,
      false
    )

    const DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED = coalesce(
      options.traceId128BitLoggingEnabled,
      process.env.DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED,
      false
    )

    this.appsecOpt = options.appsec != null ? options.appsec : options.experimental && options.experimental.appsec

    if (typeof appsec === 'boolean') {
      this.appsecOpt = {
        enabled: this.appsecOpt
      }
    } else if (this.appsecOpt == null) {
      this.appsecOpt = {}
    }

    const DD_APPSEC_ENABLED = coalesce(
      this.appsecOpt.enabled,
      process.env.DD_APPSEC_ENABLED && isTrue(process.env.DD_APPSEC_ENABLED)
    )

    const DD_APPSEC_RULES = coalesce(
      this.appsecOpt.rules,
      process.env.DD_APPSEC_RULES
    )
    const DD_APPSEC_TRACE_RATE_LIMIT = coalesce(
      parseInt(this.appsecOpt.rateLimit),
      parseInt(process.env.DD_APPSEC_TRACE_RATE_LIMIT),
      100
    )
    const DD_APPSEC_WAF_TIMEOUT = coalesce(
      parseInt(this.appsecOpt.wafTimeout),
      parseInt(process.env.DD_APPSEC_WAF_TIMEOUT),
      5e3 // µs
    )
    const DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP = coalesce(
      this.appsecOpt.obfuscatorKeyRegex,
      process.env.DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP,
      defaultObfuscatorKeyRegex
    )
    const DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP = coalesce(
      this.appsecOpt.obfuscatorValueRegex,
      process.env.DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP,
      defaultObfuscatorValueRegex
    )
    const DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML = coalesce(
      maybeFile(this.appsecOpt.blockedTemplateHtml),
      maybeFile(process.env.DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML)
    )
    const DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON = coalesce(
      maybeFile(this.appsecOpt.blockedTemplateJson),
      maybeFile(process.env.DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON)
    )
    const DD_APPSEC_AUTOMATED_USER_EVENTS_TRACKING = coalesce(
      this.appsecOpt.eventTracking && this.appsecOpt.eventTracking.mode,
      process.env.DD_APPSEC_AUTOMATED_USER_EVENTS_TRACKING,
      'safe'
    ).toLowerCase()

    const remoteConfigOptions = options.remoteConfig || {}
    const DD_REMOTE_CONFIGURATION_ENABLED = coalesce(
      process.env.DD_REMOTE_CONFIGURATION_ENABLED && isTrue(process.env.DD_REMOTE_CONFIGURATION_ENABLED),
      !inServerlessEnvironment
    )
    const DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS = coalesce(
      parseFloat(remoteConfigOptions.pollInterval),
      parseFloat(process.env.DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS),
      5 // seconds
    )

    this.iastOptions = options.experimental && options.experimental.iast
    const DD_IAST_ENABLED = coalesce(
      this.iastOptions &&
      (this.iastOptions === true || this.iastOptions.enabled === true),
      process.env.DD_IAST_ENABLED,
      false
    )
    const DD_TELEMETRY_LOG_COLLECTION_ENABLED = coalesce(
      process.env.DD_TELEMETRY_LOG_COLLECTION_ENABLED,
      DD_IAST_ENABLED
    )

    const iastRequestSampling = coalesce(
      parseInt(this.iastOptions && this.iastOptions.requestSampling),
      parseInt(process.env.DD_IAST_REQUEST_SAMPLING),
      defaultIastRequestSampling
    )
    const DD_IAST_REQUEST_SAMPLING = iastRequestSampling < 0 ||
      iastRequestSampling > 100 ? defaultIastRequestSampling : iastRequestSampling

    const DD_IAST_MAX_CONCURRENT_REQUESTS = coalesce(
      parseInt(this.iastOptions && this.iastOptions.maxConcurrentRequests),
      parseInt(process.env.DD_IAST_MAX_CONCURRENT_REQUESTS),
      2
    )

    const DD_IAST_MAX_CONTEXT_OPERATIONS = coalesce(
      parseInt(this.iastOptions && this.iastOptions.maxContextOperations),
      parseInt(process.env.DD_IAST_MAX_CONTEXT_OPERATIONS),
      2
    )

    const DD_IAST_DEDUPLICATION_ENABLED = coalesce(
      this.iastOptions && this.iastOptions.deduplicationEnabled,
      process.env.DD_IAST_DEDUPLICATION_ENABLED && isTrue(process.env.DD_IAST_DEDUPLICATION_ENABLED),
      true
    )

    const DD_IAST_REDACTION_ENABLED = coalesce(
      this.iastOptions && this.iastOptions.redactionEnabled,
      !isFalse(process.env.DD_IAST_REDACTION_ENABLED),
      true
    )

    const DD_IAST_TELEMETRY_VERBOSITY = coalesce(
      this.iastOptions && this.iastOptions.telemetryVerbosity,
      process.env.DD_IAST_TELEMETRY_VERBOSITY,
      'INFORMATION'
    )

    const DD_CIVISIBILITY_GIT_UPLOAD_ENABLED = coalesce(
      process.env.DD_CIVISIBILITY_GIT_UPLOAD_ENABLED,
      true
    )

    const DD_TRACE_GIT_METADATA_ENABLED = coalesce(
      process.env.DD_TRACE_GIT_METADATA_ENABLED,
      true
    )

    const ingestion = options.ingestion || {}
    const dogstatsd = coalesce(options.dogstatsd, {})
    const sampler = {
      rateLimit: coalesce(options.rateLimit, process.env.DD_TRACE_RATE_LIMIT, ingestion.rateLimit),
      rules: coalesce(
        options.samplingRules,
        safeJsonParse(process.env.DD_TRACE_SAMPLING_RULES),
        []
      ).map(rule => {
        return remapify(rule, {
          sample_rate: 'sampleRate'
        })
      }),
      spanSamplingRules: coalesce(
        options.spanSamplingRules,
        safeJsonParse(maybeFile(process.env.DD_SPAN_SAMPLING_RULES_FILE)),
        safeJsonParse(process.env.DD_SPAN_SAMPLING_RULES),
        []
      ).map(rule => {
        return remapify(rule, {
          sample_rate: 'sampleRate',
          max_per_second: 'maxPerSecond'
        })
      })
    }

    defaultFlushInterval = inAWSLambda ? 0 : 2000

    this.tracing = !isFalse(DD_TRACING_ENABLED)
    this.dbmPropagationMode = DD_DBM_PROPAGATION_MODE
    this.dsmEnabled = isTrue(DD_DATA_STREAMS_ENABLED)
    this.openAiLogsEnabled = DD_OPENAI_LOGS_ENABLED
    this.apiKey = DD_API_KEY
    this.env = DD_ENV
    this.url = DD_CIVISIBILITY_AGENTLESS_URL ? new URL(DD_CIVISIBILITY_AGENTLESS_URL)
      : getAgentUrl(DD_TRACE_AGENT_URL, options)
    this.site = coalesce(options.site, process.env.DD_SITE, 'datadoghq.com')
    this.hostname = DD_AGENT_HOST || (this.url && this.url.hostname)
    this.port = String(DD_TRACE_AGENT_PORT || (this.url && this.url.port))
    this.flushInterval = coalesce(parseInt(options.flushInterval, 10), defaultFlushInterval)
    this.flushMinSpans = DD_TRACE_PARTIAL_FLUSH_MIN_SPANS
    this.queryStringObfuscation = DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP
    this.clientIpEnabled = DD_TRACE_CLIENT_IP_ENABLED
    this.clientIpHeader = DD_TRACE_CLIENT_IP_HEADER
    this.plugins = !!coalesce(options.plugins, true)
    this.service = DD_SERVICE
    this.serviceMapping = DD_SERVICE_MAPPING
    this.version = DD_VERSION
    this.dogstatsd = {
      hostname: coalesce(dogstatsd.hostname, process.env.DD_DOGSTATSD_HOSTNAME, this.hostname),
      port: String(coalesce(dogstatsd.port, process.env.DD_DOGSTATSD_PORT, 8125))
    }
    this.runtimeMetrics = isTrue(DD_RUNTIME_METRICS_ENABLED)
    this.tracePropagationStyle = {
      inject: DD_TRACE_PROPAGATION_STYLE_INJECT,
      extract: DD_TRACE_PROPAGATION_STYLE_EXTRACT
    }
    this.experimental = {
      runtimeId: isTrue(DD_TRACE_RUNTIME_ID_ENABLED),
      exporter: DD_TRACE_EXPORTER,
      enableGetRumData: isTrue(DD_TRACE_GET_RUM_DATA_ENABLED)
    }
    this.sampler = sampler
    this.reportHostname = isTrue(coalesce(options.reportHostname, process.env.DD_TRACE_REPORT_HOSTNAME, false))
    this.scope = process.env.DD_TRACE_SCOPE
    this.profiling = {
      enabled: isTrue(DD_PROFILING_ENABLED),
      sourceMap: !isFalse(DD_PROFILING_SOURCE_MAP),
      exporters: DD_PROFILING_EXPORTERS
    }
    this.spanAttributeSchema = DD_TRACE_SPAN_ATTRIBUTE_SCHEMA
    this.spanComputePeerService = DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED
    this.spanRemoveIntegrationFromService = DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED
    this.peerServiceMapping = DD_TRACE_PEER_SERVICE_MAPPING
    this.lookup = options.lookup
    this.startupLogs = isTrue(DD_TRACE_STARTUP_LOGS)
    // Disabled for CI Visibility's agentless
    this.telemetry = {
      enabled: DD_TRACE_EXPORTER !== 'datadog' && isTrue(DD_TRACE_TELEMETRY_ENABLED),
      heartbeatInterval: DD_TELEMETRY_HEARTBEAT_INTERVAL,
      logCollection: isTrue(DD_TELEMETRY_LOG_COLLECTION_ENABLED),
      debug: isTrue(DD_TELEMETRY_DEBUG),
      metrics: isTrue(DD_TELEMETRY_METRICS_ENABLED),
      dependencyCollection: DD_TELEMETRY_DEPENDENCY_COLLECTION_ENABLED
    }
    this.protocolVersion = DD_TRACE_AGENT_PROTOCOL_VERSION
    this.tagsHeaderMaxLength = parseInt(DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH)
    this.appsec = {
      enabled: DD_APPSEC_ENABLED,
      rules: DD_APPSEC_RULES ? safeJsonParse(maybeFile(DD_APPSEC_RULES)) : require('./appsec/recommended.json'),
      customRulesProvided: !!DD_APPSEC_RULES,
      rateLimit: DD_APPSEC_TRACE_RATE_LIMIT,
      wafTimeout: DD_APPSEC_WAF_TIMEOUT,
      obfuscatorKeyRegex: DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP,
      obfuscatorValueRegex: DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP,
      blockedTemplateHtml: DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML,
      blockedTemplateJson: DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON,
      eventTracking: {
        enabled: ['extended', 'safe'].includes(DD_APPSEC_AUTOMATED_USER_EVENTS_TRACKING),
        mode: DD_APPSEC_AUTOMATED_USER_EVENTS_TRACKING
      }
    }
    this.remoteConfig = {
      enabled: DD_REMOTE_CONFIGURATION_ENABLED,
      pollInterval: DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS
    }
    this.iast = {
      enabled: isTrue(DD_IAST_ENABLED),
      requestSampling: DD_IAST_REQUEST_SAMPLING,
      maxConcurrentRequests: DD_IAST_MAX_CONCURRENT_REQUESTS,
      maxContextOperations: DD_IAST_MAX_CONTEXT_OPERATIONS,
      deduplicationEnabled: DD_IAST_DEDUPLICATION_ENABLED,
      redactionEnabled: DD_IAST_REDACTION_ENABLED,
      telemetryVerbosity: DD_IAST_TELEMETRY_VERBOSITY
    }

    this.isCiVisibility = isTrue(DD_IS_CIVISIBILITY)

    this.isIntelligentTestRunnerEnabled = this.isCiVisibility && isTrue(DD_CIVISIBILITY_ITR_ENABLED)
    this.isGitUploadEnabled = this.isCiVisibility &&
      (this.isIntelligentTestRunnerEnabled && !isFalse(DD_CIVISIBILITY_GIT_UPLOAD_ENABLED))

    this.gitMetadataEnabled = isTrue(DD_TRACE_GIT_METADATA_ENABLED)
    this.isManualApiEnabled = this.isCiVisibility && isTrue(DD_CIVISIBILITY_MANUAL_API_ENABLED)

    this.openaiSpanCharLimit = DD_OPENAI_SPAN_CHAR_LIMIT

    // Requires an accompanying DD_APM_OBFUSCATION_MEMCACHED_KEEP_COMMAND=true in the agent
    this.memcachedCommandEnabled = isTrue(DD_TRACE_MEMCACHED_COMMAND_ENABLED)

    if (this.gitMetadataEnabled) {
      this.repositoryUrl = coalesce(
        process.env.DD_GIT_REPOSITORY_URL,
        this.tags[GIT_REPOSITORY_URL]
      )
      this.commitSHA = coalesce(
        process.env.DD_GIT_COMMIT_SHA,
        this.tags[GIT_COMMIT_SHA]
      )
      if (!this.repositoryUrl || !this.commitSHA) {
        const DD_GIT_PROPERTIES_FILE = coalesce(
          process.env.DD_GIT_PROPERTIES_FILE,
          `${process.cwd()}/git.properties`
        )
        let gitPropertiesString
        try {
          gitPropertiesString = fs.readFileSync(DD_GIT_PROPERTIES_FILE, 'utf8')
        } catch (e) {
          // Only log error if the user has set a git.properties path
          if (process.env.DD_GIT_PROPERTIES_FILE) {
            log.error(e)
          }
        }
        if (gitPropertiesString) {
          const { commitSHA, repositoryUrl } = getGitMetadataFromGitProperties(gitPropertiesString)
          this.commitSHA = this.commitSHA || commitSHA
          this.repositoryUrl = this.repositoryUrl || repositoryUrl
        }
      }
    }

    this.stats = {
      enabled: isTrue(DD_TRACE_STATS_COMPUTATION_ENABLED)
    }

    this.traceId128BitGenerationEnabled = isTrue(DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED)
    this.traceId128BitLoggingEnabled = isTrue(DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED)

    this.isGCPFunction = isGCPFunction
    this.isAzureFunctionConsumptionPlan = isAzureFunctionConsumptionPlan

    tagger.add(this.tags, {
      service: this.service,
      env: this.env,
      version: this.version,
      'runtime-id': uuid()
    })

    this._applyDefaults()
    this._applyEnvironment()
    this._applyOptions(options)
    this._applyRemote({})
    this._merge(options)
  }

  // Supports only a subset of options for now.
  configure (options, remote) {
    if (remote) {
      this._applyRemote(options)
    } else {
      this._applyOptions(options)
    }

    this._merge(options)
  }

  _applyDefaults () {
    const defaults = this._defaults = {}

    this._setUnit(defaults, 'sampleRate', undefined)
    this._setBoolean(defaults, 'logInjection', false)
    this._setArray(defaults, 'headerTags', [])
    this._setBoolean(defaults, 'tracing', true)
    this._setValue(defaults, 'dbmPropagationMode', 'disabled')
    this._setBoolean(defaults, 'dsmEnabled', false)
    this._setBoolean(defaults, 'openAiLogsEnabled', false)
    this._setValue(defaults, 'env', undefined)
    this._setValue(defaults, 'url', 'unix:///var/run/datadog/apm.socket')
    this._setValue(defaults, 'site', 'datadoghq.com')
    this._setValue(defaults, 'hostname', '127.0.0.1')
    this._setValue(defaults, 'port', '8126')
    this._setValue(defaults, 'flushInterval', defaultFlushInterval)
    this._setValue(defaults, 'flushMinSpans', 1000)
    this._setValue(defaults, 'queryStringObfuscation', qsRegex)
    this._setBoolean(defaults, 'clientIpEnabled', false)
    this._setValue(defaults, 'clientIpHeader', null)
    this._setBoolean(defaults, 'plugins', true)
    this._setValue(defaults, 'service', 'node')
    this._setValue(defaults, 'serviceMapping', {})
    this._setValue(defaults, 'version', undefined)
    this._setValue(defaults, 'dogstatsd.hostname', {})
    this._setValue(defaults, 'dogstatsd.port', '8125')
    this._setBoolean(defaults, 'runtimeMetrics', false)
    this._setArray(defaults, 'tracePropagationStyle.inject', this.defaultPropagationStyle)
    this._setArray(defaults, 'tracePropagationStyle.extract', this.defaultPropagationStyle)
    this._setBoolean(defaults, 'experimental.runtimeId', false)
    this._setValue(defaults, 'experimental.exporter', undefined)
    this._setBoolean(defaults, 'experimental.enableGetRumData', false)
    this._setValue(defaults, 'sampler.rateLimit', undefined)
    this._setBoolean(defaults, 'reportHostname', false)
    this._setValue(defaults, 'scope', undefined)
    this._setBoolean(defaults, 'profiling.enabled', false)
    this._setValue(defaults, 'profiling.sourceMap', undefined)
    this._setValue(defaults, 'profiling.exporters', 'agent')
    this._setValue(defaults, 'spanAttributeSchema', 'v0')
    this._setValue(defaults, 'spanRemoveIntegrationFromService', false)
    this._setValue(defaults, 'peerServiceMapping', formatPeerServiceMapping({}))
    this._setValue(defaults, 'lookup', undefined)
    this._setBoolean(defaults, 'startupLogs', false)
    this._setValue(defaults, 'telemetry.enabled', undefined)
    this._setValue(defaults, 'telemetry.heartbeatInterval', 60000)
    this._setBoolean(defaults, 'telemetry.logCollection', false)
    this._setBoolean(defaults, 'telemetry.debug', false)
    this._setBoolean(defaults, 'telemetry.metrics', false)
    this._setBoolean(defaults, 'telemetry.dependencyCollection', true)
    this._setValue(defaults, 'protocolVersion', '0.4')
    this._setValue(defaults, 'tagsHeaderMaxLength', 512)
    this._setValue(defaults, 'appsec.enabled', undefined)
    this._setValue(defaults, 'appsec.rules', JSON.stringify(require('./appsec/recommended.json')))
    this._setValue(defaults, 'appsec.customRulesProvided', undefined)
    this._setValue(defaults, 'appsec.rateLimit', 100)
    this._setValue(defaults, 'appsec.wafTimeout', 5e3)
    this._setValue(defaults, 'appsec.obfuscatorKeyRegex', defaultObfuscatorKeyRegex)
    this._setValue(defaults, 'appsec.obfuscatorValueRegex', defaultObfuscatorValueRegex)
    this._setValue(defaults, 'appsec.blockedTemplateHtml', undefined)
    this._setValue(defaults, 'appsec.blockedTemplateJson', undefined)
    this._setValue(defaults, 'remoteConfig.pollInterval', 5)
    this._setBoolean(defaults, 'iast.enabled', false)
    this._setValue(defaults, 'iast.requestSampling', defaultIastRequestSampling)
    this._setValue(defaults, 'iast.maxConcurrentRequests', 2)
    this._setValue(defaults, 'iast.maxContextOperations', 2)
    this._setBoolean(defaults, 'iast.deduplicationEnabled', true)
    this._setBoolean(defaults, 'iast.redactionEnabled', true)
    this._setValue(defaults, 'iast.telemetryVerbosity', 'INFORMATION')
    this._setBoolean(defaults, 'isCiVisibility', false)
    this._setBoolean(defaults, 'gitMetadataEnabled', true)
    this._setValue(defaults, 'openaiSpanCharLimit', 128)
    if (this.gitMetadataEnabled) {
      this._setValue(defaults, 'repositoryUrl', undefined)
      this._setValue(defaults, 'commitSHA', undefined)
    }
    this._setBoolean(defaults, 'traceId128BitGenerationEnabled', false)
    this._setBoolean(defaults, 'traceId128BitLoggingEnabled', false)
  }

  _applyEnvironment () {
    const {
      DD_TRACE_SAMPLE_RATE,
      DD_LOGS_INJECTION,
      DD_TRACE_HEADER_TAGS,
      DD_TRACING_ENABLED,
      DD_DBM_PROPAGATION_MODE,
      DD_DATA_STREAMS_ENABLED,
      DD_OPENAI_LOGS_ENABLED,
      DD_ENV,
      DD_CIVISIBILITY_AGENTLESS_URL,
      DD_TRACE_AGENT_URL,
      DD_TRACE_URL,
      DD_SITE,
      DD_AGENT_HOST,
      DD_TRACE_AGENT_HOSTNAME,
      DD_TRACE_AGENT_PORT,
      DD_TRACE_PARTIAL_FLUSH_MIN_SPANS,
      DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP,
      DD_TRACE_CLIENT_IP_ENABLED,
      DD_TRACE_CLIENT_IP_HEADER,
      DD_SERVICE,
      DD_SERVICE_NAME,
      AWS_LAMBDA_FUNCTION_NAME,
      FUNCTION_NAME,
      K_SERVICE,
      WEBSITE_SITE_NAME,
      DD_SERVICE_MAPPING,
      DD_VERSION,
      DD_DOGSTATSD_HOSTNAME,
      DD_DOGSTATSD_PORT,
      DD_RUNTIME_METRICS_ENABLED,
      DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED,
      DD_TRACE_EXPERIMENTAL_EXPORTER,
      DD_TRACE_EXPERIMENTAL_GET_RUM_DATA_ENABLED,
      DD_TRACE_RATE_LIMIT,
      DD_TRACE_REPORT_HOSTNAME,
      DD_TRACE_SCOPE,
      DD_EXPERIMENTAL_PROFILING_ENABLED,
      DD_PROFILING_ENABLED,
      DD_PROFILING_SOURCE_MAP,
      DD_PROFILING_EXPORTERS,
      DD_TRACE_SPAN_ATTRIBUTE_SCHEMA,
      DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED,
      DD_TRACE_STARTUP_LOGS,
      DD_TELEMETRY_HEARTBEAT_INTERVAL,
      DD_TELEMETRY_LOG_COLLECTION_ENABLED,
      DD_IAST_ENABLED,
      DD_TELEMETRY_DEBUG,
      DD_TELEMETRY_METRICS_ENABLED,
      DD_TELEMETRY_DEPENDENCY_COLLECTION_ENABLED,
      DD_TRACE_AGENT_PROTOCOL_VERSION,
      DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH,
      DD_APPSEC_ENABLED,
      DD_APPSEC_RULES,
      DD_APPSEC_TRACE_RATE_LIMIT,
      DD_APPSEC_WAF_TIMEOUT,
      DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP,
      DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP,
      DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML,
      DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON,
      DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS,
      DD_IAST_REQUEST_SAMPLING,
      DD_IAST_MAX_CONCURRENT_REQUESTS,
      DD_IAST_MAX_CONTEXT_OPERATIONS,
      DD_IAST_DEDUPLICATION_ENABLED,
      DD_IAST_REDACTION_ENABLED,
      DD_IAST_TELEMETRY_VERBOSITY,
      DD_TRACE_GIT_METADATA_ENABLED,
      DD_OPENAI_SPAN_CHAR_LIMIT,
      DD_GIT_REPOSITORY_URL,
      DD_GIT_COMMIT_SHA,
      DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED,
      DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED,
      DD_TRACE_PEER_SERVICE_MAPPING
    } = process.env

    const env = this._env = {}

    this._setUnit(env, 'sampleRate', DD_TRACE_SAMPLE_RATE)
    this._setBoolean(env, 'logInjection', DD_LOGS_INJECTION)
    this._setArray(env, 'headerTags', DD_TRACE_HEADER_TAGS)
    this._setBoolean(env, 'tracing', !isFalse(DD_TRACING_ENABLED))
    this._setValue(env, 'dbmPropagationMode', DD_DBM_PROPAGATION_MODE)
    this._setBoolean(env, 'dsmEnabled', DD_DATA_STREAMS_ENABLED)
    this._setBoolean(env, 'openAiLogsEnabled', DD_OPENAI_LOGS_ENABLED)
    this._setValue(env, 'env', DD_ENV)
    this._setValue(env, 'url', coalesce(DD_CIVISIBILITY_AGENTLESS_URL, DD_TRACE_AGENT_URL, DD_TRACE_URL))
    this._setValue(env, 'site', DD_SITE)
    this._setValue(env, 'hostname', coalesce(DD_AGENT_HOST, DD_TRACE_AGENT_HOSTNAME))
    this._setValue(env, 'port', DD_TRACE_AGENT_PORT)
    this._setValue(env, 'flushMinSpans', parseInt(DD_TRACE_PARTIAL_FLUSH_MIN_SPANS))
    this._setValue(env, 'queryStringObfuscation', DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP)
    this._setBoolean(env, 'clientIpEnabled', DD_TRACE_CLIENT_IP_ENABLED)
    this._setValue(env, 'clientIpHeader', DD_TRACE_CLIENT_IP_HEADER)
    this._setValue(env, 'service', DD_SERVICE || DD_SERVICE_NAME ||
    AWS_LAMBDA_FUNCTION_NAME || FUNCTION_NAME || K_SERVICE || WEBSITE_SITE_NAME)
    if (DD_SERVICE_MAPPING) this._setValue(fromEntries(DD_SERVICE_MAPPING.split(',').map(x => x.trim().split(':'))))
    this._setValue(env, 'version', DD_VERSION)
    this._setValue(env, 'dogstatsd.hostname',
      coalesce(DD_DOGSTATSD_HOSTNAME, DD_CIVISIBILITY_AGENTLESS_URL, DD_TRACE_AGENT_URL, DD_TRACE_URL))
    this._setValue(env, 'dogstatsd.port', DD_DOGSTATSD_PORT)
    this._setValue(env, 'runtimeMetrics', DD_RUNTIME_METRICS_ENABLED)
    if (this.propagationStyleInject[0] === 'env_var') {
      this._setArray(env, 'tracePropagationStyle.inject', this.propagationStyleInject[1])
    }
    if (this.propagationStyleExtract[0] === 'env_var') {
      this._setArray(env, 'tracePropagationStyle.extract', this.propagationStyleExtract[1])
    }
    this._setBoolean(env, 'experimental.runtimeId', DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED)
    this._setValue(env, 'experimental.exporter', DD_TRACE_EXPERIMENTAL_EXPORTER)
    this._setBoolean(env, 'experimental.enableGetRumData', DD_TRACE_EXPERIMENTAL_GET_RUM_DATA_ENABLED)
    this._setValue(env, 'sampler.rateLimit', DD_TRACE_RATE_LIMIT)
    this._setBoolean(env, 'reportHostname', DD_TRACE_REPORT_HOSTNAME)
    this._setValue(env, 'scope', DD_TRACE_SCOPE)
    this._setBoolean(env, 'profiling.enabled', coalesce(DD_EXPERIMENTAL_PROFILING_ENABLED, DD_PROFILING_ENABLED))
    this._setBoolean(env, 'profiling.sourceMap', !isFalse(DD_PROFILING_SOURCE_MAP))
    this._setValue(env, 'profiling.exporters', DD_PROFILING_EXPORTERS)
    this._setValue(env, 'spanAttributeSchema', validateNamingVersion(DD_TRACE_SPAN_ATTRIBUTE_SCHEMA))
    this._setBoolean(env, 'spanRemoveIntegrationFromService', DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED)
    if (DD_TRACE_PEER_SERVICE_MAPPING) {
      this._setValue(env, 'peerServiceMapping', formatPeerServiceMapping(this.peerServiceMapping))
    }
    this._setBoolean(env, 'startupLogs', DD_TRACE_STARTUP_LOGS)
    this._setValue(env, 'telemetry.heartbeatInterval', Math.floor(parseFloat(DD_TELEMETRY_HEARTBEAT_INTERVAL) * 1000))
    this._setBoolean(env, 'telemetry.logCollection', coalesce(DD_TELEMETRY_LOG_COLLECTION_ENABLED, DD_IAST_ENABLED))
    this._setBoolean(env, 'telemetry.debug', DD_TELEMETRY_DEBUG)
    this._setBoolean(env, 'telemetry.metrics', DD_TELEMETRY_METRICS_ENABLED)
    this._setBoolean(env, 'telemetry.dependencyCollection', DD_TELEMETRY_DEPENDENCY_COLLECTION_ENABLED)
    this._setValue(env, 'protocolVersion', DD_TRACE_AGENT_PROTOCOL_VERSION)
    this._setValue(env, 'tagsHeaderMaxLength', DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH)
    this._setBoolean(env, 'appsec.enabled', isTrue(DD_APPSEC_ENABLED))
    this._setValue(env, 'appsec.rules', JSON.stringify(safeJsonParse(maybeFile(DD_APPSEC_RULES))))
    this._setBoolean(env, 'appsec.customRulesProvided', DD_APPSEC_RULES)
    this._setValue(env, 'appsec.rateLimit', parseInt(DD_APPSEC_TRACE_RATE_LIMIT))
    this._setValue(env, 'appsec.wafTimeout', parseInt(DD_APPSEC_WAF_TIMEOUT))
    this._setValue(env, 'appsec.obfuscatorKeyRegex', DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP)
    this._setValue(env, 'appsec.obfuscatorValueRegex', DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP)
    this._setValue(env, 'appsec.blockedTemplateHtml', maybeFile(DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML))
    this._setValue(env, 'appsec.blockedTemplateJson', maybeFile(DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON))
    this._setValue(env, 'remoteConfig.pollInterval', parseFloat(DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS))
    this._setBoolean(env, 'iast.enabled', DD_IAST_ENABLED)
    this._setValue(env, 'iast.requestSampling', parseInt(DD_IAST_REQUEST_SAMPLING))
    this._setValue(env, 'iast.maxConcurrentRequests', parseInt(DD_IAST_MAX_CONCURRENT_REQUESTS))
    this._setValue(env, 'iast.maxContextOperations', parseInt(DD_IAST_MAX_CONTEXT_OPERATIONS))
    this._setBoolean(env, 'iast.deduplicationEnabled', isTrue(DD_IAST_DEDUPLICATION_ENABLED))
    this._setBoolean(env, 'iast.redactionEnabled', !isFalse(DD_IAST_REDACTION_ENABLED))
    this._setValue(env, 'iast.telemetryVerbosity', DD_IAST_TELEMETRY_VERBOSITY)
    this._setBoolean(env, 'gitMetadataEnabled', DD_TRACE_GIT_METADATA_ENABLED)
    this._setValue(env, 'openaiSpanCharLimit', parseInt(DD_OPENAI_SPAN_CHAR_LIMIT))
    if (this.gitMetadataEnabled) {
      this._setValue(env, 'repositoryUrl', DD_GIT_REPOSITORY_URL)
      this._setValue(env, 'commitSHA', DD_GIT_COMMIT_SHA)
    }
    this._setBoolean(env, 'traceId128BitGenerationEnabled', DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED)
    this._setBoolean(env, 'traceId128BitLoggingEnabled', DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED)
  }

  _applyOptions (options) {
    const opts = this._options = this._options || {}

    options = Object.assign({ ingestion: {} }, options, opts)

    this._setUnit(opts, 'sampleRate', coalesce(options.sampleRate, options.ingestion.sampleRate))
    this._setBoolean(opts, 'logInjection', options.logInjection)
    this._setArray(opts, 'headerTags', options.headerTags)
    this._setValue(opts, 'dbmPropagationMode', options.dbmPropagationMode)
    this._setBoolean(opts, 'dsmEnabled', options.dsmEnabled)
    this._setBoolean(opts, 'openAiLogsEnabled', options.openAiLogsEnabled)
    this._setValue(opts, 'env', coalesce(options.env, this.tags.env))
    this._setValue(opts, 'url', options.url)
    this._setValue(opts, 'site', options.site)
    this._setValue(opts, 'hostname', options.hostname)
    this._setValue(opts, 'port', options.port)
    this._setValue(opts, 'flushInterval', parseInt(options.flushInterval, 10))
    this._setValue(opts, 'flushMinSpans', parseInt(options.flushMinSpans))
    this._setBoolean(opts, 'clientIpEnabled', options.clientIpEnabled)
    this._setValue(opts, 'clientIpHeader', options.clientIpHeader)
    this._setBoolean(opts, 'plugins', options.plugins)
    this._setValue(opts, 'service', options.service || this.tags.service || pkg.name)
    this._setValue(opts, 'serviceMapping', options.serviceMapping)
    this._setValue(opts, 'version', options.version || this.tags.version || pkg.version)
    this._setValue(opts, 'dogstatsd.hostname', coalesce(options.dogstatsd?.hostname, options.hostname))
    this._setValue(opts, 'dogstatsd.port', options.dogstatsd?.port)
    this._setValue(opts, 'runtimeMetrics', options.runtimeMetrics)
    if (this.propagationStyleInject[0] === 'env_var') {
      this._setArray(opts, 'tracePropagationStyle.inject', this.propagationStyleInject[1])
    }
    if (this.propagationStyleExtract[0] === 'env_var') {
      this._setArray(opts, 'tracePropagationStyle.extract', this.propagationStyleExtract[1])
    }
    this._setBoolean(opts, 'experimental.runtimeId', options.experimental && options.experimental.runtimeId)
    this._setValue(opts, 'experimental.exporter', options.experimental && options.experimental.exporter)
    this._setBoolean(opts, 'experimental.enableGetRumData',
      options.experimental && options.experimental.enableGetRumData)
    this._setValue(opts, 'sampler.rateLimit', coalesce(options.rateLimit, options.ingestion.rateLimit))
    this._setBoolean(opts, 'reportHostname', options.reportHostname)
    this._setBoolean(opts, 'profiling.enabled', options.profiling)
    this._setValue(opts, 'spanAttributeSchema', validateNamingVersion(options.spanAttributeSchema))
    this._setBoolean(opts, 'spanRemoveIntegrationFromService', options.spanRemoveIntegrationFromService)
    this._setValue(opts, 'peerServiceMapping', formatPeerServiceMapping(options.peerServiceMapping))
    this._setValue(opts, 'lookup', options.lookup)
    this._setBoolean(opts, 'startupLogs', options.startupLogs)
    this._setBoolean(opts, 'telemetry.logCollection',
      this.iastOptions && (this.iastOptions === true || this.iastOptions.enabled === true))
    this._setValue(opts, 'protocolVersion', options.protocolVersion)
    this._setBoolean(opts, 'appsec.enabled', this.appsecOpt.enabled)
    this._setValue(opts, 'appsec.rules', JSON.stringify(safeJsonParse(maybeFile(this.appsecOpt.rules))))
    this._setBoolean(opts, 'appsec.customRulesProvided', this.appsecOpt.rules)
    this._setValue(opts, 'appsec.rateLimit', parseInt(this.appsecOpt.rateLimit))
    this._setValue(opts, 'appsec.wafTimeout', parseInt(this.appsecOpt.wafTimeout))
    this._setValue(opts, 'appsec.obfuscatorKeyRegex', this.appsecOpt.obfuscatorKeyRegex)
    this._setValue(opts, 'appsec.obfuscatorValueRegex', this.appsecOpt.obfuscatorValueRegex)
    this._setValue(opts, 'appsec.blockedTemplateHtml', maybeFile(this.appsecOpt.blockedTemplateHtml))
    this._setValue(opts, 'appsec.blockedTemplateJson', maybeFile(this.appsecOpt.blockedTemplateJson))
    if (options.remoteConfig) {
      this._setValue(opts, 'remoteConfig.pollInterval', parseFloat(options.remoteConfig.pollInterval))
    }
    this._setBoolean(opts, 'iast.enabled',
      this.iastOptions && (this.iastOptions === true || this.iastOptions.enabled === true))
    this._setValue(opts, 'iast.requestSampling', parseInt(this.iastOptions && this.iastOptions.requestSampling))
    this._setValue(opts, 'iast.maxConcurrentRequests',
      parseInt(this.iastOptions && this.iastOptions.maxConcurrentRequests))
    this._setValue(opts, 'iast.maxContextOperations',
      parseInt(this.iastOptions && this.iastOptions.maxContextOperations))
    this._setBoolean(opts, 'iast.deduplicationEnabled', this.iastOptions && this.iastOptions.deduplicationEnabled)
    this._setBoolean(opts, 'iast.redactionEnabled', this.iastOptions && this.iastOptions.redactionEnabled)
    this._setValue(opts, 'iast.telemetryVerbosity', this.iastOptions && this.iastOptions.telemetryVerbosity)
    this._setBoolean(opts, 'isCiVisibility', options.isCiVisibility)
    if (this.gitMetadataEnabled) {
      this._setValue(opts, 'repositoryUrl', this.tags[GIT_REPOSITORY_URL])
      this._setValue(opts, 'commitSHA', this.tags[GIT_COMMIT_SHA])
    }
    this._setBoolean(opts, 'traceId128BitGenerationEnabled', options.traceId128BitGenerationEnabled)
  }

  _applyRemote (options) {
    const opts = this._remote = this._remote || {}
    const headerTags = options.tracing_header_tags
      ? options.tracing_header_tags.map(tag => {
        return tag.tag_name ? `${tag.header}:${tag.tag_name}` : tag.header
      })
      : undefined

    this._setUnit(opts, 'sampleRate', options.tracing_sampling_rate)
    this._setBoolean(opts, 'logInjection', options.log_injection_enabled)
    this._setArray(opts, 'headerTags', headerTags)
  }

  _setBoolean (obj, name, value) {
    if (value === undefined || value === null) {
      this._setValue(obj, name, value)
    } else if (isTrue(value)) {
      this._setValue(obj, name, true)
    } else if (isFalse(value)) {
      this._setValue(obj, name, false)
    }
  }

  _setUnit (obj, name, value) {
    if (value === null || value === undefined) {
      return this._setValue(obj, name, value)
    }

    value = parseFloat(value)

    if (!isNaN(value)) {
      // TODO: Ignore out of range values instead of normalizing them.
      this._setValue(obj, name, Math.min(Math.max(value, 0), 1))
    }
  }

  _setArray (obj, name, value) {
    if (value === null || value === undefined) {
      return this._setValue(obj, name, null)
    }

    if (typeof value === 'string') {
      value = value && value.split(',')
    }

    if (Array.isArray(value)) {
      this._setValue(obj, name, value)
    }
  }

  _setValue (obj, name, value) {
    obj[name] = value
  }

  // TODO: Report origin changes and errors to telemetry.
  // TODO: Deeply merge configurations.
  // TODO: Move change tracking to telemetry.
  _merge (options) {
    const containers = [this._remote, this._options, this._env, this._defaults]
    const origins = ['remote_config', 'code', 'env_var', 'default']
    const changes = []

    for (const name in this._defaults) {
      for (let i = 0; i < containers.length; i++) {
        const container = containers[i]
        const origin = origins[i]

        if ((container[name] !== null && container[name] !== undefined && !isNaN(container[name])) ||
        container === this._defaults) {
          if (this[name] === container[name] && this.hasOwnProperty(name)) break

          const value = this[name] = container[name]

          changes.push({ name, value, origin })

          break
        }
      }
    }

    this.sampler.sampleRate = this.sampleRate

    changes.push({
      name: 'spanComputePeerService',
      value: this.spanComputePeerService,
      origin: 'calculated'
    })
    changes.push({
      name: 'telemetry.enabled',
      value: this.telemetry.enabled,
      origin: 'env_var'
    })
    changes.push({
      name: 'remoteConfig.enabled',
      value: this.remoteConfig.enabled,
      origin: 'env_var'
    })
    changes.push({
      name: 'isIntelligentTestRunnerEnabled',
      value: this.isIntelligentTestRunnerEnabled,
      origin: this.isIntelligentTestRunnerEnabled ? 'calculated' : 'default'
    })
    changes.push({
      name: 'isGitUploadEnabled',
      value: this.isGitUploadEnabled,
      origin: this.isGitUploadEnabled ? 'calculated' : 'default'
    })
    changes.push({
      name: 'isManualApiEnabled',
      value: this.isManualApiEnabled,
      origin: this.isManualApiEnabled ? 'calculated' : 'default'
    })
    changes.push({
      name: 'stats.enabled',
      value: this.stats.enabled,
      origin: options.stats ? 'code' : 'env_var'
    })
    changes.push({
      name: 'isGCPFunction',
      value: this.isGCPFunction,
      origin: 'env_var'
    })

    updateConfig(changes, this)

    return changes // returning for test purposes
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

function formatPeerServiceMapping (peerServiceMapping) {
// format peerServiceMapping from an object to a string map in order for
// telemetry intake to accept the configuration
  return peerServiceMapping
    ? Object.entries(peerServiceMapping).map(([key, value]) => `${key}:${value}`).join(',')
    : ''
}

module.exports = Config
