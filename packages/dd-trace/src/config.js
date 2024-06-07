'use strict'

const fs = require('fs')
const os = require('os')
const uuid = require('crypto-randomuuid') // we need to keep the old uuid dep because of cypress
const URL = require('url').URL
const log = require('./log')
const pkg = require('./pkg')
const coalesce = require('koalas')
const tagger = require('./tagger')
const get = require('../../datadog-core/src/utils/src/get')
const has = require('../../datadog-core/src/utils/src/has')
const set = require('../../datadog-core/src/utils/src/set')
const { isTrue, isFalse } = require('./util')
const { GIT_REPOSITORY_URL, GIT_COMMIT_SHA } = require('./plugins/util/tags')
const { getGitMetadataFromGitProperties, removeUserSensitiveInfo } = require('./git_properties')
const { updateConfig } = require('./telemetry')
const telemetryMetrics = require('./telemetry/metrics')
const { getIsGCPFunction, getIsAzureFunction } = require('./serverless')
const { ORIGIN_KEY } = require('./constants')

const tracerMetrics = telemetryMetrics.manager.namespace('tracers')

const telemetryCounters = {
  'otel.env.hiding': {},
  'otel.env.invalid': {}
}

function getCounter (event, ddVar, otelVar, otelTracesSamplerArg) {
  const counters = telemetryCounters[event]
  const tags = []

  if (ddVar) tags.push(ddVar)
  if (otelVar) tags.push(otelVar)
  if (otelTracesSamplerArg) tags.push(otelTracesSamplerArg)

  if (!(ddVar in counters)) counters[ddVar] = {}

  const counter = tracerMetrics.count(event, tags)
  counters[ddVar][otelVar] = counter
  return counter
}

const otelDdEnvMapping = {
  DD_TRACE_LOG_LEVEL: 'OTEL_LOG_LEVEL',
  DD_TRACE_PROPAGATION_STYLE: 'OTEL_PROPAGATORS',
  DD_SERVICE: 'OTEL_SERVICE_NAME',
  DD_TRACE_SAMPLE_RATE: 'OTEL_TRACES_SAMPLER',
  DD_TRACE_ENABLED: 'OTEL_TRACES_EXPORTER',
  DD_RUNTIME_METRICS_ENABLED: 'OTEL_METRICS_EXPORTER',
  DD_TAGS: 'OTEL_RESOURCE_ATTRIBUTES',
  DD_TRACE_OTEL_ENABLED: 'OTEL_SDK_DISABLED'
}

const otelInvalidEnv = ['OTEL_LOGS_EXPORTER']

function checkIfBothOtelAndDdEnvVarSet () {
  for (const [ddVar, otelVar] of Object.entries(otelDdEnvMapping)) {
    if (process.env[ddVar] && process.env[otelVar]) {
      log.warn(`both ${ddVar} and ${otelVar} environment variables are set`)
      getCounter('otel.env.hiding', ddVar, otelVar,
        otelVar === 'OTEL_TRACES_SAMPLER' &&
        process.env.OTEL_TRACES_SAMPLER_ARG
          ? 'OTEL_TRACES_SAMPLER_ARG'
          : undefined).inc()
    }
  }

  for (const otelVar of otelInvalidEnv) {
    if (process.env[otelVar]) {
      log.warn(`${otelVar} is not supported by the Datadog SDK`)
      getCounter('otel.env.invalid', otelVar).inc()
    }
  }
}

const fromEntries = Object.fromEntries || (entries =>
  entries.reduce((obj, [k, v]) => Object.assign(obj, { [k]: v }), {}))

// eslint-disable-next-line max-len
const qsRegex = '(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?|access_?|secret_?)key(?:_?id)?|token|consumer_?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?)(?:(?:\\s|%20)*(?:=|%3D)[^&]+|(?:"|%22)(?:\\s|%20)*(?::|%3A)(?:\\s|%20)*(?:"|%22)(?:%2[^2]|%[^2]|[^"%])+(?:"|%22))|bearer(?:\\s|%20)+[a-z0-9\\._\\-]+|token(?::|%3A)[a-z0-9]{13}|gh[opsu]_[0-9a-zA-Z]{36}|ey[I-L](?:[\\w=-]|%3D)+\\.ey[I-L](?:[\\w=-]|%3D)+(?:\\.(?:[\\w.+\\/=-]|%3D|%2F|%2B)+)?|[\\-]{5}BEGIN(?:[a-z\\s]|%20)+PRIVATE(?:\\s|%20)KEY[\\-]{5}[^\\-]+[\\-]{5}END(?:[a-z\\s]|%20)+PRIVATE(?:\\s|%20)KEY|ssh-rsa(?:\\s|%20)*(?:[a-z0-9\\/\\.+]|%2F|%5C|%2B){100,}'
// eslint-disable-next-line max-len
const defaultWafObfuscatorKeyRegex = '(?i)(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?)key)|token|consumer_?(?:id|key|secret)|sign(?:ed|ature)|bearer|authorization'
// eslint-disable-next-line max-len
const defaultWafObfuscatorValueRegex = '(?i)(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?|access_?|secret_?)key(?:_?id)?|token|consumer_?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?)(?:\\s*=[^;]|"\\s*:\\s*"[^"]+")|bearer\\s+[a-z0-9\\._\\-]+|token:[a-z0-9]{13}|gh[opsu]_[0-9a-zA-Z]{36}|ey[I-L][\\w=-]+\\.ey[I-L][\\w=-]+(?:\\.[\\w.+\\/=-]+)?|[\\-]{5}BEGIN[a-z\\s]+PRIVATE\\sKEY[\\-]{5}[^\\-]+[\\-]{5}END[a-z\\s]+PRIVATE\\sKEY|ssh-rsa\\s*[a-z0-9\\/\\.+]{100,}'
const runtimeId = uuid()

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

  const envVar = coalesce(process.env[envKey], process.env.DD_TRACE_PROPAGATION_STYLE, process.env.OTEL_PROPAGATORS)
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
    options = this.options = {
      ...options,
      appsec: options.appsec != null ? options.appsec : options.experimental?.appsec,
      iastOptions: options.experimental?.iast
    }

    checkIfBothOtelAndDdEnvVarSet()

    // Configure the logger first so it can be used to warn about other configs
    this.debug = isTrue(coalesce(
      process.env.DD_TRACE_DEBUG,
      process.env.OTEL_LOG_LEVEL && process.env.OTEL_LOG_LEVEL === 'debug',
      false
    ))
    this.logger = options.logger

    this.logLevel = coalesce(
      options.logLevel,
      process.env.DD_TRACE_LOG_LEVEL,
      process.env.OTEL_LOG_LEVEL,
      'debug'
    )

    log.use(this.logger)
    log.toggle(this.debug, this.logLevel, this)

    const DD_TRACE_MEMCACHED_COMMAND_ENABLED = coalesce(
      process.env.DD_TRACE_MEMCACHED_COMMAND_ENABLED,
      false
    )

    const DD_SERVICE_MAPPING = coalesce(
      options.serviceMapping,
      process.env.DD_SERVICE_MAPPING
        ? fromEntries(
          process.env.DD_SERVICE_MAPPING.split(',').map(x => x.trim().split(':'))
        )
        : {}
    )

    const DD_API_KEY = coalesce(
      process.env.DATADOG_API_KEY,
      process.env.DD_API_KEY
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
    const PROPAGATION_STYLE_INJECT = propagationStyle(
      'inject',
      options.tracePropagationStyle,
      defaultPropagationStyle
    )
    const PROPAGATION_STYLE_EXTRACT = propagationStyle(
      'extract',
      options.tracePropagationStyle,
      defaultPropagationStyle
    )
    const DD_TRACE_PROPAGATION_EXTRACT_FIRST = coalesce(
      process.env.DD_TRACE_PROPAGATION_EXTRACT_FIRST,
      false
    )

    if (typeof options.appsec === 'boolean') {
      options.appsec = {
        enabled: options.appsec
      }
    } else if (options.appsec == null) {
      options.appsec = {}
    }

    const DD_APPSEC_GRAPHQL_BLOCKED_TEMPLATE_JSON = coalesce(
      maybeFile(options.appsec.blockedTemplateGraphql),
      maybeFile(process.env.DD_APPSEC_GRAPHQL_BLOCKED_TEMPLATE_JSON)
    )
    const DD_APPSEC_AUTOMATED_USER_EVENTS_TRACKING = coalesce(
      options.appsec.eventTracking && options.appsec.eventTracking.mode,
      process.env.DD_APPSEC_AUTOMATED_USER_EVENTS_TRACKING,
      'safe'
    ).toLowerCase()
    const DD_API_SECURITY_ENABLED = coalesce(
      options.appsec?.apiSecurity?.enabled,
      process.env.DD_API_SECURITY_ENABLED && isTrue(process.env.DD_API_SECURITY_ENABLED),
      process.env.DD_EXPERIMENTAL_API_SECURITY_ENABLED && isTrue(process.env.DD_EXPERIMENTAL_API_SECURITY_ENABLED),
      true
    )
    const DD_API_SECURITY_REQUEST_SAMPLE_RATE = coalesce(
      options.appsec?.apiSecurity?.requestSampling,
      parseFloat(process.env.DD_API_SECURITY_REQUEST_SAMPLE_RATE),
      0.1
    )

    // 0: disabled, 1: logging, 2: garbage collection + logging
    const DD_TRACE_SPAN_LEAK_DEBUG = coalesce(
      process.env.DD_TRACE_SPAN_LEAK_DEBUG,
      0
    )

    const DD_INSTRUMENTATION_INSTALL_ID = coalesce(
      process.env.DD_INSTRUMENTATION_INSTALL_ID,
      null
    )
    const DD_INSTRUMENTATION_INSTALL_TIME = coalesce(
      process.env.DD_INSTRUMENTATION_INSTALL_TIME,
      null
    )
    const DD_INSTRUMENTATION_INSTALL_TYPE = coalesce(
      process.env.DD_INSTRUMENTATION_INSTALL_TYPE,
      null
    )

    const sampler = {
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

    // TODO: refactor
    this.apiKey = DD_API_KEY
    this.serviceMapping = DD_SERVICE_MAPPING
    this.tracePropagationStyle = {
      inject: PROPAGATION_STYLE_INJECT,
      extract: PROPAGATION_STYLE_EXTRACT,
      otelPropagators: process.env.DD_TRACE_PROPAGATION_STYLE ||
        process.env.DD_TRACE_PROPAGATION_STYLE_INJECT ||
        process.env.DD_TRACE_PROPAGATION_STYLE_EXTRACT
        ? false
        : !!process.env.OTEL_PROPAGATORS
    }
    this.tracePropagationExtractFirst = isTrue(DD_TRACE_PROPAGATION_EXTRACT_FIRST)
    this.sampler = sampler
    this.appsec = {
      blockedTemplateGraphql: DD_APPSEC_GRAPHQL_BLOCKED_TEMPLATE_JSON,
      eventTracking: {
        enabled: ['extended', 'safe'].includes(DD_APPSEC_AUTOMATED_USER_EVENTS_TRACKING),
        mode: DD_APPSEC_AUTOMATED_USER_EVENTS_TRACKING
      },
      apiSecurity: {
        enabled: DD_API_SECURITY_ENABLED,
        // Coerce value between 0 and 1
        requestSampling: Math.min(1, Math.max(0, DD_API_SECURITY_REQUEST_SAMPLE_RATE))
      }
    }

    // Requires an accompanying DD_APM_OBFUSCATION_MEMCACHED_KEEP_COMMAND=true in the agent
    this.memcachedCommandEnabled = isTrue(DD_TRACE_MEMCACHED_COMMAND_ENABLED)
    this.isAzureFunction = getIsAzureFunction()
    this.spanLeakDebug = Number(DD_TRACE_SPAN_LEAK_DEBUG)
    this.installSignature = {
      id: DD_INSTRUMENTATION_INSTALL_ID,
      time: DD_INSTRUMENTATION_INSTALL_TIME,
      type: DD_INSTRUMENTATION_INSTALL_TYPE
    }

    this._applyDefaults()
    this._applyEnvironment()
    this._applyOptions(options)
    this._applyCalculated()
    this._applyRemote({})
    this._merge()

    tagger.add(this.tags, {
      service: this.service,
      env: this.env,
      version: this.version,
      'runtime-id': runtimeId
    })

    if (this.isCiVisibility) {
      tagger.add(this.tags, {
        [ORIGIN_KEY]: 'ciapp-test'
      })
    }

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
  }

  // Supports only a subset of options for now.
  configure (options, remote) {
    if (remote) {
      this._applyRemote(options)
    } else {
      this._applyOptions(options)
    }

    // TODO: test
    this._applyCalculated()
    this._merge()
  }

  _isInServerlessEnvironment () {
    const inAWSLambda = process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined
    const isGCPFunction = getIsGCPFunction()
    const isAzureFunction = getIsAzureFunction()
    return inAWSLambda || isGCPFunction || isAzureFunction
  }

  // for _merge to work, every config value must have a default value
  _applyDefaults () {
    const {
      AWS_LAMBDA_FUNCTION_NAME,
      FUNCTION_NAME,
      K_SERVICE,
      WEBSITE_SITE_NAME
    } = process.env

    const service = AWS_LAMBDA_FUNCTION_NAME ||
      FUNCTION_NAME || // Google Cloud Function Name set by deprecated runtimes
      K_SERVICE || // Google Cloud Function Name set by newer runtimes
      WEBSITE_SITE_NAME || // set by Azure Functions
      pkg.name ||
      'node'

    const defaults = this._defaults = {}

    this._setValue(defaults, 'appsec.blockedTemplateHtml', undefined)
    this._setValue(defaults, 'appsec.blockedTemplateJson', undefined)
    this._setValue(defaults, 'appsec.enabled', undefined)
    this._setValue(defaults, 'appsec.obfuscatorKeyRegex', defaultWafObfuscatorKeyRegex)
    this._setValue(defaults, 'appsec.obfuscatorValueRegex', defaultWafObfuscatorValueRegex)
    this._setValue(defaults, 'appsec.rasp.enabled', false)
    this._setValue(defaults, 'appsec.rateLimit', 100)
    this._setValue(defaults, 'appsec.rules', undefined)
    this._setValue(defaults, 'appsec.sca.enabled', null)
    this._setValue(defaults, 'appsec.wafTimeout', 5e3) // µs
    this._setValue(defaults, 'clientIpEnabled', false)
    this._setValue(defaults, 'clientIpHeader', null)
    this._setValue(defaults, 'dbmPropagationMode', 'disabled')
    this._setValue(defaults, 'dogstatsd.hostname', '127.0.0.1')
    this._setValue(defaults, 'dogstatsd.port', '8125')
    this._setValue(defaults, 'dsmEnabled', false)
    this._setValue(defaults, 'env', undefined)
    this._setValue(defaults, 'experimental.enableGetRumData', false)
    this._setValue(defaults, 'experimental.exporter', undefined)
    this._setValue(defaults, 'experimental.runtimeId', false)
    this._setValue(defaults, 'flushInterval', 2000)
    this._setValue(defaults, 'flushMinSpans', 1000)
    this._setValue(defaults, 'gitMetadataEnabled', true)
    this._setValue(defaults, 'headerTags', [])
    this._setValue(defaults, 'hostname', '127.0.0.1')
    this._setValue(defaults, 'iast.deduplicationEnabled', true)
    this._setValue(defaults, 'iast.enabled', false)
    this._setValue(defaults, 'iast.maxConcurrentRequests', 2)
    this._setValue(defaults, 'iast.maxContextOperations', 2)
    this._setValue(defaults, 'iast.redactionEnabled', true)
    this._setValue(defaults, 'iast.redactionNamePattern', null)
    this._setValue(defaults, 'iast.redactionValuePattern', null)
    this._setValue(defaults, 'iast.requestSampling', 30)
    this._setValue(defaults, 'iast.telemetryVerbosity', 'INFORMATION')
    this._setValue(defaults, 'isCiVisibility', false)
    this._setValue(defaults, 'isEarlyFlakeDetectionEnabled', false)
    this._setValue(defaults, 'isGCPFunction', false)
    this._setValue(defaults, 'isGitUploadEnabled', false)
    this._setValue(defaults, 'isIntelligentTestRunnerEnabled', false)
    this._setValue(defaults, 'isManualApiEnabled', false)
    this._setValue(defaults, 'logInjection', false)
    this._setValue(defaults, 'lookup', undefined)
    this._setValue(defaults, 'openAiLogsEnabled', false)
    this._setValue(defaults, 'openaiSpanCharLimit', 128)
    this._setValue(defaults, 'peerServiceMapping', {})
    this._setValue(defaults, 'plugins', true)
    this._setValue(defaults, 'port', '8126')
    this._setValue(defaults, 'profiling.enabled', undefined)
    this._setValue(defaults, 'profiling.exporters', 'agent')
    this._setValue(defaults, 'profiling.sourceMap', true)
    this._setValue(defaults, 'profiling.ssi', false)
    this._setValue(defaults, 'profiling.heuristicsEnabled', false)
    this._setValue(defaults, 'profiling.longLivedThreshold', undefined)
    this._setValue(defaults, 'protocolVersion', '0.4')
    this._setValue(defaults, 'queryStringObfuscation', qsRegex)
    this._setValue(defaults, 'remoteConfig.enabled', true)
    this._setValue(defaults, 'remoteConfig.pollInterval', 5) // seconds
    this._setValue(defaults, 'reportHostname', false)
    this._setValue(defaults, 'runtimeMetrics', false)
    this._setValue(defaults, 'sampleRate', undefined)
    this._setValue(defaults, 'sampler.rateLimit', undefined)
    this._setValue(defaults, 'sampler.rules', [])
    this._setValue(defaults, 'scope', undefined)
    this._setValue(defaults, 'service', service)
    this._setValue(defaults, 'site', 'datadoghq.com')
    this._setValue(defaults, 'spanAttributeSchema', 'v0')
    this._setValue(defaults, 'spanComputePeerService', false)
    this._setValue(defaults, 'spanRemoveIntegrationFromService', false)
    this._setValue(defaults, 'startupLogs', false)
    this._setValue(defaults, 'stats.enabled', false)
    this._setValue(defaults, 'tags', {})
    this._setValue(defaults, 'tagsHeaderMaxLength', 512)
    this._setValue(defaults, 'telemetry.debug', false)
    this._setValue(defaults, 'telemetry.dependencyCollection', true)
    this._setValue(defaults, 'telemetry.enabled', true)
    this._setValue(defaults, 'telemetry.heartbeatInterval', 60000)
    this._setValue(defaults, 'telemetry.logCollection', false)
    this._setValue(defaults, 'telemetry.metrics', true)
    this._setValue(defaults, 'traceId128BitGenerationEnabled', true)
    this._setValue(defaults, 'traceId128BitLoggingEnabled', false)
    this._setValue(defaults, 'tracing', true)
    this._setValue(defaults, 'url', undefined)
    this._setValue(defaults, 'version', pkg.version)
    this._setValue(defaults, 'instrumentation_config_id', undefined)
  }

  _applyEnvironment () {
    const {
      AWS_LAMBDA_FUNCTION_NAME,
      DD_AGENT_HOST,
      DD_APPSEC_ENABLED,
      DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML,
      DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON,
      DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP,
      DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP,
      DD_APPSEC_RULES,
      DD_APPSEC_SCA_ENABLED,
      DD_APPSEC_RASP_ENABLED,
      DD_APPSEC_TRACE_RATE_LIMIT,
      DD_APPSEC_WAF_TIMEOUT,
      DD_DATA_STREAMS_ENABLED,
      DD_DBM_PROPAGATION_MODE,
      DD_DOGSTATSD_HOSTNAME,
      DD_DOGSTATSD_PORT,
      DD_ENV,
      DD_EXPERIMENTAL_PROFILING_ENABLED,
      JEST_WORKER_ID,
      DD_IAST_DEDUPLICATION_ENABLED,
      DD_IAST_ENABLED,
      DD_IAST_MAX_CONCURRENT_REQUESTS,
      DD_IAST_MAX_CONTEXT_OPERATIONS,
      DD_IAST_REDACTION_ENABLED,
      DD_IAST_REDACTION_NAME_PATTERN,
      DD_IAST_REDACTION_VALUE_PATTERN,
      DD_IAST_REQUEST_SAMPLING,
      DD_IAST_TELEMETRY_VERBOSITY,
      DD_INJECTION_ENABLED,
      DD_INSTRUMENTATION_TELEMETRY_ENABLED,
      DD_INSTRUMENTATION_CONFIG_ID,
      DD_LOGS_INJECTION,
      DD_OPENAI_LOGS_ENABLED,
      DD_OPENAI_SPAN_CHAR_LIMIT,
      DD_PROFILING_ENABLED,
      DD_PROFILING_EXPORTERS,
      DD_PROFILING_SOURCE_MAP,
      DD_INTERNAL_PROFILING_LONG_LIVED_THRESHOLD,
      DD_REMOTE_CONFIGURATION_ENABLED,
      DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS,
      DD_RUNTIME_METRICS_ENABLED,
      DD_SERVICE,
      DD_SERVICE_NAME,
      DD_SITE,
      DD_TAGS,
      DD_TELEMETRY_DEBUG,
      DD_TELEMETRY_DEPENDENCY_COLLECTION_ENABLED,
      DD_TELEMETRY_HEARTBEAT_INTERVAL,
      DD_TELEMETRY_LOG_COLLECTION_ENABLED,
      DD_TELEMETRY_METRICS_ENABLED,
      DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED,
      DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED,
      DD_TRACE_AGENT_HOSTNAME,
      DD_TRACE_AGENT_PORT,
      DD_TRACE_AGENT_PROTOCOL_VERSION,
      DD_TRACE_CLIENT_IP_ENABLED,
      DD_TRACE_CLIENT_IP_HEADER,
      DD_TRACE_EXPERIMENTAL_EXPORTER,
      DD_TRACE_EXPERIMENTAL_GET_RUM_DATA_ENABLED,
      DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED,
      DD_TRACE_GIT_METADATA_ENABLED,
      DD_TRACE_GLOBAL_TAGS,
      DD_TRACE_HEADER_TAGS,
      DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP,
      DD_TRACE_PARTIAL_FLUSH_MIN_SPANS,
      DD_TRACE_PEER_SERVICE_MAPPING,
      DD_TRACE_RATE_LIMIT,
      DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED,
      DD_TRACE_REPORT_HOSTNAME,
      DD_TRACE_SAMPLE_RATE,
      DD_TRACE_SAMPLING_RULES,
      DD_TRACE_SCOPE,
      DD_TRACE_SPAN_ATTRIBUTE_SCHEMA,
      DD_TRACE_STARTUP_LOGS,
      DD_TRACE_TAGS,
      DD_TRACE_TELEMETRY_ENABLED,
      DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH,
      DD_TRACING_ENABLED,
      DD_VERSION,
      OTEL_SERVICE_NAME,
      OTEL_RESOURCE_ATTRIBUTES,
      OTEL_TRACES_SAMPLER,
      OTEL_TRACES_SAMPLER_ARG,
      OTEL_METRICS_EXPORTER
    } = process.env

    const tags = {}
    const env = this._env = {}
    this._envUnprocessed = {}

    tagger.add(tags, OTEL_RESOURCE_ATTRIBUTES, true)
    tagger.add(tags, DD_TAGS)
    tagger.add(tags, DD_TRACE_TAGS)
    tagger.add(tags, DD_TRACE_GLOBAL_TAGS)

    this._setValue(env, 'appsec.blockedTemplateHtml', maybeFile(DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML))
    this._envUnprocessed['appsec.blockedTemplateHtml'] = DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML
    this._setValue(env, 'appsec.blockedTemplateJson', maybeFile(DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON))
    this._envUnprocessed['appsec.blockedTemplateJson'] = DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON
    this._setBoolean(env, 'appsec.enabled', DD_APPSEC_ENABLED)
    this._setString(env, 'appsec.obfuscatorKeyRegex', DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP)
    this._setString(env, 'appsec.obfuscatorValueRegex', DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP)
    this._setBoolean(env, 'appsec.rasp.enabled', DD_APPSEC_RASP_ENABLED)
    this._setValue(env, 'appsec.rateLimit', maybeInt(DD_APPSEC_TRACE_RATE_LIMIT))
    this._envUnprocessed['appsec.rateLimit'] = DD_APPSEC_TRACE_RATE_LIMIT
    this._setString(env, 'appsec.rules', DD_APPSEC_RULES)
    // DD_APPSEC_SCA_ENABLED is never used locally, but only sent to the backend
    this._setBoolean(env, 'appsec.sca.enabled', DD_APPSEC_SCA_ENABLED)
    this._setValue(env, 'appsec.wafTimeout', maybeInt(DD_APPSEC_WAF_TIMEOUT))
    this._envUnprocessed['appsec.wafTimeout'] = DD_APPSEC_WAF_TIMEOUT
    this._setBoolean(env, 'clientIpEnabled', DD_TRACE_CLIENT_IP_ENABLED)
    this._setString(env, 'clientIpHeader', DD_TRACE_CLIENT_IP_HEADER)
    this._setString(env, 'dbmPropagationMode', DD_DBM_PROPAGATION_MODE)
    this._setString(env, 'dogstatsd.hostname', DD_DOGSTATSD_HOSTNAME)
    this._setString(env, 'dogstatsd.port', DD_DOGSTATSD_PORT)
    this._setBoolean(env, 'dsmEnabled', DD_DATA_STREAMS_ENABLED)
    this._setString(env, 'env', DD_ENV || tags.env)
    this._setBoolean(env, 'experimental.enableGetRumData', DD_TRACE_EXPERIMENTAL_GET_RUM_DATA_ENABLED)
    this._setString(env, 'experimental.exporter', DD_TRACE_EXPERIMENTAL_EXPORTER)
    this._setBoolean(env, 'experimental.runtimeId', DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED)
    if (AWS_LAMBDA_FUNCTION_NAME) this._setValue(env, 'flushInterval', 0)
    this._setValue(env, 'flushMinSpans', maybeInt(DD_TRACE_PARTIAL_FLUSH_MIN_SPANS))
    this._envUnprocessed.flushMinSpans = DD_TRACE_PARTIAL_FLUSH_MIN_SPANS
    this._setBoolean(env, 'gitMetadataEnabled', DD_TRACE_GIT_METADATA_ENABLED)
    this._setArray(env, 'headerTags', DD_TRACE_HEADER_TAGS)
    this._setString(env, 'hostname', coalesce(DD_AGENT_HOST, DD_TRACE_AGENT_HOSTNAME))
    this._setBoolean(env, 'iast.deduplicationEnabled', DD_IAST_DEDUPLICATION_ENABLED)
    this._setBoolean(env, 'iast.enabled', DD_IAST_ENABLED)
    this._setValue(env, 'iast.maxConcurrentRequests', maybeInt(DD_IAST_MAX_CONCURRENT_REQUESTS))
    this._envUnprocessed['iast.maxConcurrentRequests'] = DD_IAST_MAX_CONCURRENT_REQUESTS
    this._setValue(env, 'iast.maxContextOperations', maybeInt(DD_IAST_MAX_CONTEXT_OPERATIONS))
    this._envUnprocessed['iast.maxContextOperations'] = DD_IAST_MAX_CONTEXT_OPERATIONS
    this._setBoolean(env, 'iast.redactionEnabled', DD_IAST_REDACTION_ENABLED && !isFalse(DD_IAST_REDACTION_ENABLED))
    this._setString(env, 'iast.redactionNamePattern', DD_IAST_REDACTION_NAME_PATTERN)
    this._setString(env, 'iast.redactionValuePattern', DD_IAST_REDACTION_VALUE_PATTERN)
    const iastRequestSampling = maybeInt(DD_IAST_REQUEST_SAMPLING)
    if (iastRequestSampling > -1 && iastRequestSampling < 101) {
      this._setValue(env, 'iast.requestSampling', iastRequestSampling)
    }
    this._envUnprocessed['iast.requestSampling'] = DD_IAST_REQUEST_SAMPLING
    this._setString(env, 'iast.telemetryVerbosity', DD_IAST_TELEMETRY_VERBOSITY)
    this._setBoolean(env, 'isGCPFunction', getIsGCPFunction())
    this._setBoolean(env, 'logInjection', DD_LOGS_INJECTION)
    this._setBoolean(env, 'openAiLogsEnabled', DD_OPENAI_LOGS_ENABLED)
    this._setValue(env, 'openaiSpanCharLimit', maybeInt(DD_OPENAI_SPAN_CHAR_LIMIT))
    this._envUnprocessed.openaiSpanCharLimit = DD_OPENAI_SPAN_CHAR_LIMIT
    if (DD_TRACE_PEER_SERVICE_MAPPING) {
      this._setValue(env, 'peerServiceMapping', fromEntries(
        DD_TRACE_PEER_SERVICE_MAPPING.split(',').map(x => x.trim().split(':'))
      ))
      this._envUnprocessed.peerServiceMapping = DD_TRACE_PEER_SERVICE_MAPPING
    }
    this._setString(env, 'port', DD_TRACE_AGENT_PORT)
    this._setBoolean(env, 'profiling.enabled', coalesce(DD_EXPERIMENTAL_PROFILING_ENABLED, DD_PROFILING_ENABLED))
    this._setString(env, 'profiling.exporters', DD_PROFILING_EXPORTERS)
    this._setBoolean(env, 'profiling.sourceMap', DD_PROFILING_SOURCE_MAP && !isFalse(DD_PROFILING_SOURCE_MAP))
    if (DD_PROFILING_ENABLED === 'auto' || DD_INJECTION_ENABLED) {
      this._setBoolean(env, 'profiling.ssi', true)
      if (DD_PROFILING_ENABLED === 'auto' || DD_INJECTION_ENABLED.split(',').includes('profiler')) {
        this._setBoolean(env, 'profiling.heuristicsEnabled', true)
      }
      if (DD_INTERNAL_PROFILING_LONG_LIVED_THRESHOLD) {
        // This is only used in testing to not have to wait 30s
        this._setValue(env, 'profiling.longLivedThreshold', Number(DD_INTERNAL_PROFILING_LONG_LIVED_THRESHOLD))
      }
    }

    this._setString(env, 'protocolVersion', DD_TRACE_AGENT_PROTOCOL_VERSION)
    this._setString(env, 'queryStringObfuscation', DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP)
    this._setBoolean(env, 'remoteConfig.enabled', coalesce(
      DD_REMOTE_CONFIGURATION_ENABLED,
      !this._isInServerlessEnvironment()
    ))
    this._setValue(env, 'remoteConfig.pollInterval', maybeFloat(DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS))
    this._envUnprocessed['remoteConfig.pollInterval'] = DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS
    this._setBoolean(env, 'reportHostname', DD_TRACE_REPORT_HOSTNAME)
    // only used to explicitly set runtimeMetrics to false
    const otelSetRuntimeMetrics = String(OTEL_METRICS_EXPORTER).toLowerCase() === 'none'
      ? false
      : undefined
    this._setBoolean(env, 'runtimeMetrics', DD_RUNTIME_METRICS_ENABLED ||
    otelSetRuntimeMetrics)
    const OTEL_TRACES_SAMPLER_MAPPING = {
      always_on: '1.0',
      always_off: '0.0',
      traceidratio: OTEL_TRACES_SAMPLER_ARG,
      parentbased_always_on: '1.0',
      parentbased_always_off: '0.0',
      parentbased_traceidratio: OTEL_TRACES_SAMPLER_ARG
    }
    this._setUnit(env, 'sampleRate', DD_TRACE_SAMPLE_RATE || OTEL_TRACES_SAMPLER_MAPPING[OTEL_TRACES_SAMPLER])
    this._setValue(env, 'sampler.rateLimit', DD_TRACE_RATE_LIMIT)
    this._setSamplingRule(env, 'sampler.rules', safeJsonParse(DD_TRACE_SAMPLING_RULES))
    this._envUnprocessed['sampler.rules'] = DD_TRACE_SAMPLING_RULES
    this._setString(env, 'scope', DD_TRACE_SCOPE)
    this._setString(env, 'service', DD_SERVICE || DD_SERVICE_NAME || tags.service || OTEL_SERVICE_NAME)
    this._setString(env, 'site', DD_SITE)
    if (DD_TRACE_SPAN_ATTRIBUTE_SCHEMA) {
      this._setString(env, 'spanAttributeSchema', validateNamingVersion(DD_TRACE_SPAN_ATTRIBUTE_SCHEMA))
      this._envUnprocessed.spanAttributeSchema = DD_TRACE_SPAN_ATTRIBUTE_SCHEMA
    }
    this._setBoolean(env, 'spanRemoveIntegrationFromService', DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED)
    this._setBoolean(env, 'startupLogs', DD_TRACE_STARTUP_LOGS)
    this._setTags(env, 'tags', tags)
    this._setValue(env, 'tagsHeaderMaxLength', DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH)
    this._setBoolean(env, 'telemetry.enabled', coalesce(
      DD_TRACE_TELEMETRY_ENABLED, // for backward compatibility
      DD_INSTRUMENTATION_TELEMETRY_ENABLED, // to comply with instrumentation telemetry specs
      !(this._isInServerlessEnvironment() || JEST_WORKER_ID)
    ))
    this._setString(env, 'instrumentation_config_id', DD_INSTRUMENTATION_CONFIG_ID)
    this._setBoolean(env, 'telemetry.debug', DD_TELEMETRY_DEBUG)
    this._setBoolean(env, 'telemetry.dependencyCollection', DD_TELEMETRY_DEPENDENCY_COLLECTION_ENABLED)
    this._setValue(env, 'telemetry.heartbeatInterval', maybeInt(Math.floor(DD_TELEMETRY_HEARTBEAT_INTERVAL * 1000)))
    this._envUnprocessed['telemetry.heartbeatInterval'] = DD_TELEMETRY_HEARTBEAT_INTERVAL * 1000
    const hasTelemetryLogsUsingFeatures =
      env['iast.enabled'] || env['profiling.enabled'] || env['profiling.heuristicsEnabled']
        ? true
        : undefined
    this._setBoolean(env, 'telemetry.logCollection', coalesce(DD_TELEMETRY_LOG_COLLECTION_ENABLED,
      hasTelemetryLogsUsingFeatures))
    this._setBoolean(env, 'telemetry.metrics', DD_TELEMETRY_METRICS_ENABLED)
    this._setBoolean(env, 'traceId128BitGenerationEnabled', DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED)
    this._setBoolean(env, 'traceId128BitLoggingEnabled', DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED)
    this._setBoolean(env, 'tracing', DD_TRACING_ENABLED)
    this._setString(env, 'version', DD_VERSION || tags.version)
  }

  _applyOptions (options) {
    const opts = this._options = this._options || {}
    const tags = {}
    this._optsUnprocessed = {}

    options = this.options = Object.assign({ ingestion: {} }, options, opts)

    tagger.add(tags, options.tags)

    this._setValue(opts, 'appsec.blockedTemplateHtml', maybeFile(options.appsec.blockedTemplateHtml))
    this._optsUnprocessed['appsec.blockedTemplateHtml'] = options.appsec.blockedTemplateHtml
    this._setValue(opts, 'appsec.blockedTemplateJson', maybeFile(options.appsec.blockedTemplateJson))
    this._optsUnprocessed['appsec.blockedTemplateJson'] = options.appsec.blockedTemplateJson
    this._setBoolean(opts, 'appsec.enabled', options.appsec.enabled)
    this._setString(opts, 'appsec.obfuscatorKeyRegex', options.appsec.obfuscatorKeyRegex)
    this._setString(opts, 'appsec.obfuscatorValueRegex', options.appsec.obfuscatorValueRegex)
    this._setBoolean(opts, 'appsec.rasp.enabled', options.appsec.rasp?.enabled)
    this._setValue(opts, 'appsec.rateLimit', maybeInt(options.appsec.rateLimit))
    this._optsUnprocessed['appsec.rateLimit'] = options.appsec.rateLimit
    this._setString(opts, 'appsec.rules', options.appsec.rules)
    this._setValue(opts, 'appsec.wafTimeout', maybeInt(options.appsec.wafTimeout))
    this._optsUnprocessed['appsec.wafTimeout'] = options.appsec.wafTimeout
    this._setBoolean(opts, 'clientIpEnabled', options.clientIpEnabled)
    this._setString(opts, 'clientIpHeader', options.clientIpHeader)
    this._setString(opts, 'dbmPropagationMode', options.dbmPropagationMode)
    if (options.dogstatsd) {
      this._setString(opts, 'dogstatsd.hostname', options.dogstatsd.hostname)
      this._setString(opts, 'dogstatsd.port', options.dogstatsd.port)
    }
    this._setBoolean(opts, 'dsmEnabled', options.dsmEnabled)
    this._setString(opts, 'env', options.env || tags.env)
    this._setBoolean(opts, 'experimental.enableGetRumData',
      options.experimental && options.experimental.enableGetRumData)
    this._setString(opts, 'experimental.exporter', options.experimental && options.experimental.exporter)
    this._setBoolean(opts, 'experimental.runtimeId', options.experimental && options.experimental.runtimeId)
    this._setValue(opts, 'flushInterval', maybeInt(options.flushInterval))
    this._optsUnprocessed.flushInterval = options.flushInterval
    this._setValue(opts, 'flushMinSpans', maybeInt(options.flushMinSpans))
    this._optsUnprocessed.flushMinSpans = options.flushMinSpans
    this._setArray(opts, 'headerTags', options.headerTags)
    this._setString(opts, 'hostname', options.hostname)
    this._setBoolean(opts, 'iast.deduplicationEnabled', options.iastOptions && options.iastOptions.deduplicationEnabled)
    this._setBoolean(opts, 'iast.enabled',
      options.iastOptions && (options.iastOptions === true || options.iastOptions.enabled === true))
    this._setValue(opts, 'iast.maxConcurrentRequests',
      maybeInt(options.iastOptions?.maxConcurrentRequests))
    this._optsUnprocessed['iast.maxConcurrentRequests'] = options.iastOptions?.maxConcurrentRequests
    this._setValue(opts, 'iast.maxContextOperations', maybeInt(options.iastOptions?.maxContextOperations))
    this._optsUnprocessed['iast.maxContextOperations'] = options.iastOptions?.maxContextOperations
    this._setBoolean(opts, 'iast.redactionEnabled', options.iastOptions?.redactionEnabled)
    this._setString(opts, 'iast.redactionNamePattern', options.iastOptions?.redactionNamePattern)
    this._setString(opts, 'iast.redactionValuePattern', options.iastOptions?.redactionValuePattern)
    const iastRequestSampling = maybeInt(options.iastOptions?.requestSampling)
    if (iastRequestSampling > -1 && iastRequestSampling < 101) {
      this._setValue(opts, 'iast.requestSampling', iastRequestSampling)
      this._optsUnprocessed['iast.requestSampling'] = options.iastOptions?.requestSampling
    }
    this._setString(opts, 'iast.telemetryVerbosity', options.iastOptions && options.iastOptions.telemetryVerbosity)
    this._setBoolean(opts, 'isCiVisibility', options.isCiVisibility)
    this._setBoolean(opts, 'logInjection', options.logInjection)
    this._setString(opts, 'lookup', options.lookup)
    this._setBoolean(opts, 'openAiLogsEnabled', options.openAiLogsEnabled)
    this._setValue(opts, 'peerServiceMapping', options.peerServiceMapping)
    this._setBoolean(opts, 'plugins', options.plugins)
    this._setString(opts, 'port', options.port)
    this._setBoolean(opts, 'profiling.enabled', options.profiling)
    this._setString(opts, 'protocolVersion', options.protocolVersion)
    if (options.remoteConfig) {
      this._setValue(opts, 'remoteConfig.pollInterval', maybeFloat(options.remoteConfig.pollInterval))
      this._optsUnprocessed['remoteConfig.pollInterval'] = options.remoteConfig.pollInterval
    }
    this._setBoolean(opts, 'reportHostname', options.reportHostname)
    this._setBoolean(opts, 'runtimeMetrics', options.runtimeMetrics)
    this._setUnit(opts, 'sampleRate', coalesce(options.sampleRate, options.ingestion.sampleRate))
    const ingestion = options.ingestion || {}
    this._setValue(opts, 'sampler.rateLimit', coalesce(options.rateLimit, ingestion.rateLimit))
    this._setSamplingRule(opts, 'sampler.rules', options.samplingRules)
    this._setString(opts, 'service', options.service || tags.service)
    this._setString(opts, 'site', options.site)
    if (options.spanAttributeSchema) {
      this._setString(opts, 'spanAttributeSchema', validateNamingVersion(options.spanAttributeSchema))
      this._optsUnprocessed.spanAttributeSchema = options.spanAttributeSchema
    }
    this._setBoolean(opts, 'spanRemoveIntegrationFromService', options.spanRemoveIntegrationFromService)
    this._setBoolean(opts, 'startupLogs', options.startupLogs)
    this._setTags(opts, 'tags', tags)
    const hasTelemetryLogsUsingFeatures =
      (options.iastOptions && (options.iastOptions === true || options.iastOptions?.enabled === true)) ||
      (options.profiling && options.profiling === true)
    this._setBoolean(opts, 'telemetry.logCollection', hasTelemetryLogsUsingFeatures)
    this._setBoolean(opts, 'traceId128BitGenerationEnabled', options.traceId128BitGenerationEnabled)
    this._setBoolean(opts, 'traceId128BitLoggingEnabled', options.traceId128BitLoggingEnabled)
    this._setString(opts, 'version', options.version || tags.version)
  }

  _isCiVisibility () {
    return coalesce(
      this.options.isCiVisibility,
      this._defaults.isCiVisibility
    )
  }

  _isCiVisibilityItrEnabled () {
    return coalesce(
      process.env.DD_CIVISIBILITY_ITR_ENABLED,
      true
    )
  }

  _getHostname () {
    const DD_CIVISIBILITY_AGENTLESS_URL = process.env.DD_CIVISIBILITY_AGENTLESS_URL
    const url = DD_CIVISIBILITY_AGENTLESS_URL
      ? new URL(DD_CIVISIBILITY_AGENTLESS_URL)
      : getAgentUrl(this._getTraceAgentUrl(), this.options)
    const DD_AGENT_HOST = coalesce(
      this.options.hostname,
      process.env.DD_AGENT_HOST,
      process.env.DD_TRACE_AGENT_HOSTNAME,
      '127.0.0.1'
    )
    return DD_AGENT_HOST || (url && url.hostname)
  }

  _getSpanComputePeerService () {
    const DD_TRACE_SPAN_ATTRIBUTE_SCHEMA = validateNamingVersion(
      coalesce(
        this.options.spanAttributeSchema,
        process.env.DD_TRACE_SPAN_ATTRIBUTE_SCHEMA
      )
    )

    const peerServiceSet = (
      this.options.hasOwnProperty('spanComputePeerService') ||
      process.env.hasOwnProperty('DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED')
    )
    const peerServiceValue = coalesce(
      this.options.spanComputePeerService,
      process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED
    )

    const spanComputePeerService = (
      DD_TRACE_SPAN_ATTRIBUTE_SCHEMA === 'v0'
        // In v0, peer service is computed only if it is explicitly set to true
        ? peerServiceSet && isTrue(peerServiceValue)
        // In >v0, peer service is false only if it is explicitly set to false
        : (peerServiceSet ? !isFalse(peerServiceValue) : true)
    )

    return spanComputePeerService
  }

  _isCiVisibilityGitUploadEnabled () {
    return coalesce(
      process.env.DD_CIVISIBILITY_GIT_UPLOAD_ENABLED,
      true
    )
  }

  _isCiVisibilityManualApiEnabled () {
    return isTrue(coalesce(
      process.env.DD_CIVISIBILITY_MANUAL_API_ENABLED,
      false
    ))
  }

  _isTraceStatsComputationEnabled () {
    return coalesce(
      this.options.stats,
      process.env.DD_TRACE_STATS_COMPUTATION_ENABLED,
      getIsGCPFunction() || getIsAzureFunction()
    )
  }

  _getTraceAgentUrl () {
    return coalesce(
      this.options.url,
      process.env.DD_TRACE_AGENT_URL,
      process.env.DD_TRACE_URL,
      null
    )
  }

  // handles values calculated from a mixture of options and env vars
  _applyCalculated () {
    const calc = this._calculated = {}

    const {
      DD_CIVISIBILITY_AGENTLESS_URL
    } = process.env

    if (DD_CIVISIBILITY_AGENTLESS_URL) {
      this._setValue(calc, 'url', new URL(DD_CIVISIBILITY_AGENTLESS_URL))
    } else {
      this._setValue(calc, 'url', getAgentUrl(this._getTraceAgentUrl(), this.options))
    }
    if (this._isCiVisibility()) {
      this._setBoolean(calc, 'isEarlyFlakeDetectionEnabled',
        coalesce(process.env.DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED, true))
      this._setBoolean(calc, 'isIntelligentTestRunnerEnabled', isTrue(this._isCiVisibilityItrEnabled()))
      this._setBoolean(calc, 'isManualApiEnabled', this._isCiVisibilityManualApiEnabled())
    }
    this._setString(calc, 'dogstatsd.hostname', this._getHostname())
    this._setBoolean(calc, 'isGitUploadEnabled',
      calc.isIntelligentTestRunnerEnabled && !isFalse(this._isCiVisibilityGitUploadEnabled()))
    this._setBoolean(calc, 'spanComputePeerService', this._getSpanComputePeerService())
    this._setBoolean(calc, 'stats.enabled', this._isTraceStatsComputationEnabled())
  }

  _applyRemote (options) {
    const opts = this._remote = this._remote || {}
    this._remoteUnprocessed = {}
    const tags = {}
    const headerTags = options.tracing_header_tags
      ? options.tracing_header_tags.map(tag => {
        return tag.tag_name ? `${tag.header}:${tag.tag_name}` : tag.header
      })
      : undefined

    tagger.add(tags, options.tracing_tags)
    if (Object.keys(tags).length) tags['runtime-id'] = runtimeId

    this._setUnit(opts, 'sampleRate', options.tracing_sampling_rate)
    this._setBoolean(opts, 'logInjection', options.log_injection_enabled)
    this._setArray(opts, 'headerTags', headerTags)
    this._setTags(opts, 'tags', tags)
    this._setBoolean(opts, 'tracing', options.tracing_enabled)
    // ignore tags for now since rc sampling rule tags format is not supported
    this._setSamplingRule(opts, 'sampler.rules', this._ignoreTags(options.tracing_sampling_rules))
    this._remoteUnprocessed['sampler.rules'] = options.tracing_sampling_rules
  }

  _ignoreTags (samplingRules) {
    if (samplingRules) {
      for (const rule of samplingRules) {
        delete rule.tags
      }
    }
    return samplingRules
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
    if (value == null) {
      return this._setValue(obj, name, null)
    }

    if (typeof value === 'string') {
      value = value.split(',')
    }

    if (Array.isArray(value)) {
      this._setValue(obj, name, value)
    }
  }

  _setSamplingRule (obj, name, value) {
    if (value == null) {
      return this._setValue(obj, name, null)
    }

    if (typeof value === 'string') {
      value = value.split(',')
    }

    if (Array.isArray(value)) {
      value = value.map(rule => {
        return remapify(rule, {
          sample_rate: 'sampleRate'
        })
      })
      this._setValue(obj, name, value)
    }
  }

  _setString (obj, name, value) {
    obj[name] = value ? String(value) : undefined // unset for empty strings
  }

  _setTags (obj, name, value) {
    if (!value || Object.keys(value).length === 0) {
      return this._setValue(obj, name, null)
    }

    this._setValue(obj, name, value)
  }

  _setValue (obj, name, value) {
    obj[name] = value
  }

  // TODO: Report origin changes and errors to telemetry.
  // TODO: Deeply merge configurations.
  // TODO: Move change tracking to telemetry.
  // for telemetry reporting, `name`s in `containers` need to be keys from:
  // eslint-disable-next-line max-len
  // https://github.com/DataDog/dd-go/blob/prod/trace/apps/tracer-telemetry-intake/telemetry-payload/static/config_norm_rules.json
  _merge () {
    const containers = [this._remote, this._options, this._env, this._calculated, this._defaults]
    const origins = ['remote_config', 'code', 'env_var', 'calculated', 'default']
    const unprocessedValues = [this._remoteUnprocessed, this._optsUnprocessed, this._envUnprocessed, {}, {}]
    const changes = []

    for (const name in this._defaults) {
      for (let i = 0; i < containers.length; i++) {
        const container = containers[i]
        const origin = origins[i]
        const unprocessed = unprocessedValues[i]

        if ((container[name] !== null && container[name] !== undefined) || container === this._defaults) {
          if (get(this, name) === container[name] && has(this, name)) break

          let value = container[name]
          set(this, name, value)
          value = unprocessed[name] || value

          changes.push({ name, value, origin })

          break
        }
      }
    }

    this.sampler.sampleRate = this.sampleRate
    updateConfig(changes, this)
  }
}

function maybeInt (number) {
  const parsed = parseInt(number)
  return isNaN(parsed) ? undefined : parsed
}

function maybeFloat (number) {
  const parsed = parseFloat(number)
  return isNaN(parsed) ? undefined : parsed
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
