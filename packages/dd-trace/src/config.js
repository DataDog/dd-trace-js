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
const { getGitMetadataFromGitProperties, removeUserSensitiveInfo } = require('./git_properties')
const { updateConfig } = require('./telemetry')
const { getIsGCPFunction, getIsAzureFunctionConsumptionPlan } = require('./serverless')

const fromEntries = Object.fromEntries || (entries =>
  entries.reduce((obj, [k, v]) => Object.assign(obj, { [k]: v }), {}))

// eslint-disable-next-line max-len
const qsRegex = '(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?|access_?|secret_?)key(?:_?id)?|token|consumer_?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?)(?:(?:\\s|%20)*(?:=|%3D)[^&]+|(?:"|%22)(?:\\s|%20)*(?::|%3A)(?:\\s|%20)*(?:"|%22)(?:%2[^2]|%[^2]|[^"%])+(?:"|%22))|bearer(?:\\s|%20)+[a-z0-9\\._\\-]+|token(?::|%3A)[a-z0-9]{13}|gh[opsu]_[0-9a-zA-Z]{36}|ey[I-L](?:[\\w=-]|%3D)+\\.ey[I-L](?:[\\w=-]|%3D)+(?:\\.(?:[\\w.+\\/=-]|%3D|%2F|%2B)+)?|[\\-]{5}BEGIN(?:[a-z\\s]|%20)+PRIVATE(?:\\s|%20)KEY[\\-]{5}[^\\-]+[\\-]{5}END(?:[a-z\\s]|%20)+PRIVATE(?:\\s|%20)KEY|ssh-rsa(?:\\s|%20)*(?:[a-z0-9\\/\\.+]|%2F|%5C|%2B){100,}'

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
  if (Array.isArray(option)) return option.map(v => v.toLowerCase())

  // If it's not an array but not undefined there's something wrong with the input
  if (typeof option !== 'undefined') {
    log.warn('Unexpected input for config.tracePropagationStyle')
  }

  // Otherwise, fallback to env var parsing
  const envKey = `DD_TRACE_PROPAGATION_STYLE_${key.toUpperCase()}`
  const envVar = coalesce(process.env[envKey], process.env.DD_TRACE_PROPAGATION_STYLE)
  if (typeof envVar !== 'undefined') {
    return envVar.split(',')
      .filter(v => v !== '')
      .map(v => v.trim().toLowerCase())
  }

  return defaultValue
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

    const DD_INSTRUMENTATION_TELEMETRY_ENABLED = coalesce(
      process.env.DD_TRACE_TELEMETRY_ENABLED, // for backward compatibility
      process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED, // to comply with instrumentation telemetry specs
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
    const DD_TELEMETRY_METRICS_ENABLED = coalesce(
      process.env.DD_TELEMETRY_METRICS_ENABLED,
      true
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
    const defaultPropagationStyle = ['datadog', 'tracecontext']
    if (isTrue(DD_TRACE_B3_ENABLED)) {
      defaultPropagationStyle.push('b3')
      defaultPropagationStyle.push('b3 single header')
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
    const DD_TRACE_PROPAGATION_STYLE_INJECT = propagationStyle(
      'inject',
      options.tracePropagationStyle,
      defaultPropagationStyle
    )
    const DD_TRACE_PROPAGATION_STYLE_EXTRACT = propagationStyle(
      'extract',
      options.tracePropagationStyle,
      defaultPropagationStyle
    )
    const DD_TRACE_PROPAGATION_EXTRACT_FIRST = coalesce(
      process.env.DD_TRACE_PROPAGATION_EXTRACT_FIRST,
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

    // the tracer generates 128 bit IDs by default as of v5
    const DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED = coalesce(
      options.traceId128BitGenerationEnabled,
      process.env.DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED,
      true
    )

    const DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED = coalesce(
      options.traceId128BitLoggingEnabled,
      process.env.DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED,
      false
    )

    let appsec = options.appsec != null ? options.appsec : options.experimental && options.experimental.appsec

    if (typeof appsec === 'boolean') {
      appsec = {
        enabled: appsec
      }
    } else if (appsec == null) {
      appsec = {}
    }

    const DD_APPSEC_ENABLED = coalesce(
      appsec.enabled,
      process.env.DD_APPSEC_ENABLED && isTrue(process.env.DD_APPSEC_ENABLED)
    )
    const DD_APPSEC_RULES = coalesce(
      appsec.rules,
      process.env.DD_APPSEC_RULES
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
    const DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML = coalesce(
      maybeFile(appsec.blockedTemplateHtml),
      maybeFile(process.env.DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML)
    )
    const DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON = coalesce(
      maybeFile(appsec.blockedTemplateJson),
      maybeFile(process.env.DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON)
    )
    const DD_APPSEC_AUTOMATED_USER_EVENTS_TRACKING = coalesce(
      appsec.eventTracking && appsec.eventTracking.mode,
      process.env.DD_APPSEC_AUTOMATED_USER_EVENTS_TRACKING,
      'safe'
    ).toLowerCase()
    const DD_EXPERIMENTAL_API_SECURITY_ENABLED = coalesce(
      appsec?.apiSecurity?.enabled,
      isTrue(process.env.DD_EXPERIMENTAL_API_SECURITY_ENABLED),
      false
    )
    const DD_API_SECURITY_REQUEST_SAMPLE_RATE = coalesce(
      appsec?.apiSecurity?.requestSampling,
      parseFloat(process.env.DD_API_SECURITY_REQUEST_SAMPLE_RATE),
      0.1
    )

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

    const iastOptions = options?.experimental?.iast
    const DD_IAST_ENABLED = coalesce(
      iastOptions &&
      (iastOptions === true || iastOptions.enabled === true),
      process.env.DD_IAST_ENABLED,
      false
    )
    const DD_TELEMETRY_LOG_COLLECTION_ENABLED = coalesce(
      process.env.DD_TELEMETRY_LOG_COLLECTION_ENABLED,
      DD_IAST_ENABLED
    )

    const DD_TELEMETRY_DEPENDENCY_COLLECTION_ENABLED = coalesce(
      process.env.DD_TELEMETRY_DEPENDENCY_COLLECTION_ENABLED,
      true
    )

    const defaultIastRequestSampling = 30
    const iastRequestSampling = coalesce(
      parseInt(iastOptions?.requestSampling),
      parseInt(process.env.DD_IAST_REQUEST_SAMPLING),
      defaultIastRequestSampling
    )
    const DD_IAST_REQUEST_SAMPLING = iastRequestSampling < 0 ||
      iastRequestSampling > 100 ? defaultIastRequestSampling : iastRequestSampling

    const DD_IAST_MAX_CONCURRENT_REQUESTS = coalesce(
      parseInt(iastOptions?.maxConcurrentRequests),
      parseInt(process.env.DD_IAST_MAX_CONCURRENT_REQUESTS),
      2
    )

    const DD_IAST_MAX_CONTEXT_OPERATIONS = coalesce(
      parseInt(iastOptions?.maxContextOperations),
      parseInt(process.env.DD_IAST_MAX_CONTEXT_OPERATIONS),
      2
    )

    const DD_IAST_DEDUPLICATION_ENABLED = coalesce(
      iastOptions?.deduplicationEnabled,
      process.env.DD_IAST_DEDUPLICATION_ENABLED && isTrue(process.env.DD_IAST_DEDUPLICATION_ENABLED),
      true
    )

    const DD_IAST_REDACTION_ENABLED = coalesce(
      iastOptions?.redactionEnabled,
      !isFalse(process.env.DD_IAST_REDACTION_ENABLED),
      true
    )

    const DD_IAST_REDACTION_NAME_PATTERN = coalesce(
      iastOptions?.redactionNamePattern,
      process.env.DD_IAST_REDACTION_NAME_PATTERN,
      null
    )

    const DD_IAST_REDACTION_VALUE_PATTERN = coalesce(
      iastOptions?.redactionValuePattern,
      process.env.DD_IAST_REDACTION_VALUE_PATTERN,
      null
    )

    const DD_IAST_TELEMETRY_VERBOSITY = coalesce(
      iastOptions?.telemetryVerbosity,
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

    // 0: disabled, 1: logging, 2: garbage collection + logging
    const DD_TRACE_SPAN_LEAK_DEBUG = coalesce(
      process.env.DD_TRACE_SPAN_LEAK_DEBUG,
      0
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

    const defaultFlushInterval = inAWSLambda ? 0 : 2000

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
    this.tracePropagationExtractFirst = isTrue(DD_TRACE_PROPAGATION_EXTRACT_FIRST)
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
      enabled: DD_TRACE_EXPORTER !== 'datadog' && isTrue(DD_INSTRUMENTATION_TELEMETRY_ENABLED),
      heartbeatInterval: DD_TELEMETRY_HEARTBEAT_INTERVAL,
      debug: isTrue(DD_TELEMETRY_DEBUG),
      logCollection: isTrue(DD_TELEMETRY_LOG_COLLECTION_ENABLED),
      metrics: isTrue(DD_TELEMETRY_METRICS_ENABLED),
      dependencyCollection: DD_TELEMETRY_DEPENDENCY_COLLECTION_ENABLED
    }
    this.protocolVersion = DD_TRACE_AGENT_PROTOCOL_VERSION
    this.tagsHeaderMaxLength = parseInt(DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH)
    this.appsec = {
      enabled: DD_APPSEC_ENABLED,
      rules: DD_APPSEC_RULES,
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
      },
      apiSecurity: {
        enabled: DD_EXPERIMENTAL_API_SECURITY_ENABLED,
        // Coerce value between 0 and 1
        requestSampling: Math.min(1, Math.max(0, DD_API_SECURITY_REQUEST_SAMPLE_RATE))
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
      redactionNamePattern: DD_IAST_REDACTION_NAME_PATTERN,
      redactionValuePattern: DD_IAST_REDACTION_VALUE_PATTERN,
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
      this.repositoryUrl = removeUserSensitiveInfo(
        coalesce(
          process.env.DD_GIT_REPOSITORY_URL,
          this.tags[GIT_REPOSITORY_URL]
        )
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

    this.spanLeakDebug = Number(DD_TRACE_SPAN_LEAK_DEBUG)

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
    this._merge()
  }

  // Supports only a subset of options for now.
  configure (options, remote) {
    if (remote) {
      this._applyRemote(options)
    } else {
      this._applyOptions(options)
    }

    this._merge()
  }

  _applyDefaults () {
    const defaults = this._defaults = {}

    this._setUnit(defaults, 'sampleRate', undefined)
    this._setBoolean(defaults, 'logInjection', false)
    this._setArray(defaults, 'headerTags', [])
  }

  _applyEnvironment () {
    const {
      DD_TRACE_SAMPLE_RATE,
      DD_LOGS_INJECTION,
      DD_TRACE_HEADER_TAGS
    } = process.env

    const env = this._env = {}

    this._setUnit(env, 'sampleRate', DD_TRACE_SAMPLE_RATE)
    this._setBoolean(env, 'logInjection', DD_LOGS_INJECTION)
    this._setArray(env, 'headerTags', DD_TRACE_HEADER_TAGS)
  }

  _applyOptions (options) {
    const opts = this._options = this._options || {}

    options = Object.assign({ ingestion: {} }, options, opts)

    this._setUnit(opts, 'sampleRate', coalesce(options.sampleRate, options.ingestion.sampleRate))
    this._setBoolean(opts, 'logInjection', options.logInjection)
    this._setArray(opts, 'headerTags', options.headerTags)
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
  _merge () {
    const containers = [this._remote, this._options, this._env, this._defaults]
    const origins = ['remote_config', 'code', 'env_var', 'default']
    const changes = []

    for (const name in this._defaults) {
      for (let i = 0; i < containers.length; i++) {
        const container = containers[i]
        const origin = origins[i]

        if ((container[name] !== null && container[name] !== undefined) || container === this._defaults) {
          if (this[name] === container[name] && this.hasOwnProperty(name)) break

          const value = this[name] = container[name]

          changes.push({ name, value, origin })

          break
        }
      }
    }

    this.sampler.sampleRate = this.sampleRate

    updateConfig(changes, this)
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
