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
const defaultWafObfuscatorKeyRegex = `(?i)(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?\
|public_?)key)|token|consumer_?(?:id|key|secret)|sign(?:ed|ature)|bearer|authorization`
const defaultWafObfuscatorValueRegex =
`(?i)(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?|access_?|secret_?)key(?:_?id)?|to\
ken|consumer_?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?)(?:\\s*=[^;]|"\\s*:\\s*"[^"]+")|bearer\
\\s+[a-z0-9\\._\\-]+|token:[a-z0-9]{13}|gh[opsu]_[0-9a-zA-Z]{36}|ey[I-L][\\w=-]+\\.ey[I-L][\\w=-]+(?:\\.[\\w.+\\/=-]+)?\
|[\\-]{5}BEGIN[a-z\\s]+PRIVATE\\sKEY[\\-]{5}[^\\-]+[\\-]{5}END[a-z\\s]+PRIVATE\\sKEY|ssh-rsa\\s*[a-z0-9\\/\\.+]{100,}`

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
    options = this.options = options || {}

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

    const DD_AGENT_HOST = coalesce(
      options.hostname,
      process.env.DD_AGENT_HOST,
      process.env.DD_TRACE_AGENT_HOSTNAME,
      '127.0.0.1'
    )
    const DD_TRACE_AGENT_URL = coalesce(
      options.url,
      process.env.DD_TRACE_AGENT_URL,
      process.env.DD_TRACE_URL,
      null
    )
    this.DD_IS_CIVISIBILITY = coalesce(
      options.isCiVisibility,
      false
    )
    const DD_CIVISIBILITY_AGENTLESS_URL = process.env.DD_CIVISIBILITY_AGENTLESS_URL

    this.DD_CIVISIBILITY_ITR_ENABLED = coalesce(
      process.env.DD_CIVISIBILITY_ITR_ENABLED,
      true
    )

    this.DD_CIVISIBILITY_MANUAL_API_ENABLED = coalesce(
      process.env.DD_CIVISIBILITY_MANUAL_API_ENABLED,
      false
    )

    const DD_TRACE_MEMCACHED_COMMAND_ENABLED = coalesce(
      process.env.DD_TRACE_MEMCACHED_COMMAND_ENABLED,
      false
    )

    const DD_SERVICE_MAPPING = coalesce(
      options.serviceMapping,
      process.env.DD_SERVICE_MAPPING ? fromEntries(
        process.env.DD_SERVICE_MAPPING.split(',').map(x => x.trim().split(':'))
      ) : {}
    )

    const DD_API_KEY = coalesce(
      process.env.DATADOG_API_KEY,
      process.env.DD_API_KEY
    )

    const inAWSLambda = process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined

    const isGCPFunction = getIsGCPFunction()
    const isAzureFunctionConsumptionPlan = getIsAzureFunctionConsumptionPlan()

    const inServerlessEnvironment = inAWSLambda || isGCPFunction || isAzureFunctionConsumptionPlan

    this.DD_INSTRUMENTATION_TELEMETRY_ENABLED = coalesce(
      process.env.DD_TRACE_TELEMETRY_ENABLED, // for backward compatibility
      process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED, // to comply with instrumentation telemetry specs
      !inServerlessEnvironment
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
    const DD_TRACE_SPAN_ATTRIBUTE_SCHEMA = validateNamingVersion(
      coalesce(
        options.spanAttributeSchema,
        process.env.DD_TRACE_SPAN_ATTRIBUTE_SCHEMA
      )
    )

    const peerServiceSet = (
      options.hasOwnProperty('spanComputePeerService') ||
      process.env.hasOwnProperty('DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED')
    )
    const peerServiceValue = coalesce(
      options.spanComputePeerService,
      process.env.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED
    )

    this.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED = (
      DD_TRACE_SPAN_ATTRIBUTE_SCHEMA === 'v0'
        // In v0, peer service is computed only if it is explicitly set to true
        ? peerServiceSet && isTrue(peerServiceValue)
        // In >v0, peer service is false only if it is explicitly set to false
        : (peerServiceSet ? !isFalse(peerServiceValue) : true)
    )

    this.DD_TRACE_STATS_COMPUTATION_ENABLED = coalesce(
      options.stats,
      process.env.DD_TRACE_STATS_COMPUTATION_ENABLED,
      isGCPFunction || isAzureFunctionConsumptionPlan
    )

    this.appsecOpt = options.appsec != null ? options.appsec : options.experimental && options.experimental.appsec

    if (typeof this.appsecOpt === 'boolean') {
      this.appsecOpt = {
        enabled: this.appsecOpt
      }
    } else if (this.appsecOpt == null) {
      this.appsecOpt = {}
    }

    const DD_APPSEC_GRAPHQL_BLOCKED_TEMPLATE_JSON = coalesce(
      maybeFile(this.appsecOpt.blockedTemplateGraphql),
      maybeFile(process.env.DD_APPSEC_GRAPHQL_BLOCKED_TEMPLATE_JSON)
    )
    const DD_APPSEC_AUTOMATED_USER_EVENTS_TRACKING = coalesce(
      this.appsecOpt.eventTracking && this.appsecOpt.eventTracking.mode,
      process.env.DD_APPSEC_AUTOMATED_USER_EVENTS_TRACKING,
      'safe'
    ).toLowerCase()
    const DD_EXPERIMENTAL_API_SECURITY_ENABLED = coalesce(
      this.appsecOpt?.apiSecurity?.enabled,
      isTrue(process.env.DD_EXPERIMENTAL_API_SECURITY_ENABLED),
      false
    )
    const DD_API_SECURITY_REQUEST_SAMPLE_RATE = coalesce(
      this.appsecOpt?.apiSecurity?.requestSampling,
      parseFloat(process.env.DD_API_SECURITY_REQUEST_SAMPLE_RATE),
      0.1
    )

    this.DD_REMOTE_CONFIGURATION_ENABLED = coalesce(
      process.env.DD_REMOTE_CONFIGURATION_ENABLED && isTrue(process.env.DD_REMOTE_CONFIGURATION_ENABLED),
      !inServerlessEnvironment
    )

    this.iastOptions = options?.experimental?.iast

    this.DD_CIVISIBILITY_GIT_UPLOAD_ENABLED = coalesce(
      process.env.DD_CIVISIBILITY_GIT_UPLOAD_ENABLED,
      true
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

    this.apiKey = DD_API_KEY
    this.url = DD_CIVISIBILITY_AGENTLESS_URL ? new URL(DD_CIVISIBILITY_AGENTLESS_URL)
      : getAgentUrl(DD_TRACE_AGENT_URL, options)
    this.HOSTNAME = DD_AGENT_HOST || (this.url && this.url.hostname)
    // TODO: reporting flushInterval in telemetry app-started config breaks tracing for some reason
    this.flushInterval = coalesce(parseInt(options.flushInterval, 10), defaultFlushInterval)
    this.serviceMapping = DD_SERVICE_MAPPING
    this.tracePropagationStyle = {
      inject: DD_TRACE_PROPAGATION_STYLE_INJECT,
      extract: DD_TRACE_PROPAGATION_STYLE_EXTRACT
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
        enabled: DD_EXPERIMENTAL_API_SECURITY_ENABLED,
        // Coerce value between 0 and 1
        requestSampling: Math.min(1, Math.max(0, DD_API_SECURITY_REQUEST_SAMPLE_RATE))
      }
    }

    // Requires an accompanying DD_APM_OBFUSCATION_MEMCACHED_KEEP_COMMAND=true in the agent
    this.memcachedCommandEnabled = isTrue(DD_TRACE_MEMCACHED_COMMAND_ENABLED)

    this.isAzureFunctionConsumptionPlan = isAzureFunctionConsumptionPlan

    this.spanLeakDebug = Number(DD_TRACE_SPAN_LEAK_DEBUG)

    this.installSignature = {
      id: DD_INSTRUMENTATION_INSTALL_ID,
      time: DD_INSTRUMENTATION_INSTALL_TIME,
      type: DD_INSTRUMENTATION_INSTALL_TYPE
    }

    this._applyDefaults()
    this._applyEnvironment(options)
    this._applyOptions(options)
    this._applyCalculated(options)
    this._applyRemote({})
    this._merge()

    tagger.add(this.tags, {
      service: this.service,
      env: this.env,
      version: this.version,
      'runtime-id': uuid()
    })

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

    this._merge()
  }

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

    this._setValue(defaults, 'service', service)
    this._setValue(defaults, 'env', undefined)
    this._setValue(defaults, 'version', pkg.version)
    this._setUnit(defaults, 'sampleRate', undefined)
    this._setBoolean(defaults, 'logInjection', false)
    this._setArray(defaults, 'headerTags', [])
    this._setValue(defaults, 'tags', {})
    this._setBoolean(defaults, 'tracing', true)
    this._setValue(defaults, 'dbmPropagationMode', 'disabled')
    this._setBoolean(defaults, 'dsmEnabled', false)
    this._setBoolean(defaults, 'openAiLogsEnabled', false)
    this._setValue(defaults, 'url', undefined)
    this._setValue(defaults, 'site', 'datadoghq.com')
    this._setValue(defaults, 'hostname', '127.0.0.1')
    this._setValue(defaults, 'port', '8126')
    // this._setValue(defaults, 'flushInterval', defaultFlushInterval)
    this._setValue(defaults, 'flushMinSpans', 1000)
    this._setValue(defaults, 'queryStringObfuscation', qsRegex)
    this._setBoolean(defaults, 'clientIpEnabled', false)
    this._setValue(defaults, 'clientIpHeader', null)
    this._setBoolean(defaults, 'plugins', true)
    this._setValue(defaults, 'dogstatsd.hostname', '127.0.0.1')
    this._setValue(defaults, 'dogstatsd.port', '8125')
    this._setBoolean(defaults, 'runtimeMetrics', false)
    this._setBoolean(defaults, 'experimental.runtimeId', false)
    this._setValue(defaults, 'experimental.exporter', undefined)
    this._setBoolean(defaults, 'experimental.enableGetRumData', false)
    this._setValue(defaults, 'sampler.rateLimit', undefined)
    this._setBoolean(defaults, 'reportHostname', false)
    this._setValue(defaults, 'scope', undefined)
    this._setBoolean(defaults, 'profiling.enabled', false)
    this._setBoolean(defaults, 'profiling.sourceMap', true)
    this._setValue(defaults, 'profiling.exporters', 'agent')
    this._setValue(defaults, 'spanAttributeSchema', 'v0')
    this._setValue(defaults, 'spanRemoveIntegrationFromService', false)
    this._setValue(defaults, 'peerServiceMapping', {})
    this._setValue(defaults, 'lookup', undefined)
    this._setBoolean(defaults, 'startupLogs', false)
    this._setBoolean(defaults, 'telemetry.enabled', true)
    this._setBoolean(defaults, 'telemetry.logCollection', false)
    this._setValue(defaults, 'telemetry.heartbeatInterval', 60000)
    this._setBoolean(defaults, 'telemetry.debug', false)
    this._setBoolean(defaults, 'telemetry.metrics', true)
    this._setBoolean(defaults, 'telemetry.dependencyCollection', true)
    this._setValue(defaults, 'protocolVersion', '0.4')
    this._setValue(defaults, 'tagsHeaderMaxLength', 512)
    this._setValue(defaults, 'spanComputePeerService', false)
    this._setBoolean(defaults, 'appsec.enabled', undefined)
    this._setValue(defaults, 'appsec.rules', undefined)
    this._setValue(defaults, 'appsec.customRulesProvided', false)
    this._setValue(defaults, 'appsec.rateLimit', 100)
    this._setValue(defaults, 'appsec.wafTimeout', 5e3)
    this._setValue(defaults, 'appsec.obfuscatorKeyRegex', defaultWafObfuscatorKeyRegex)
    this._setValue(defaults, 'appsec.obfuscatorValueRegex', defaultWafObfuscatorValueRegex)
    this._setValue(defaults, 'appsec.blockedTemplateHtml', undefined)
    this._setValue(defaults, 'appsec.blockedTemplateJson', undefined)
    this._setBoolean(defaults, 'remoteConfig.enabled', true)
    this._setValue(defaults, 'remoteConfig.pollInterval', 5)
    this._setBoolean(defaults, 'iast.enabled', false)
    this._setValue(defaults, 'iast.requestSampling', 30)
    this._setValue(defaults, 'iast.maxConcurrentRequests', 2)
    this._setValue(defaults, 'iast.maxContextOperations', 2)
    this._setBoolean(defaults, 'iast.deduplicationEnabled', true)
    this._setBoolean(defaults, 'iast.redactionEnabled', true)
    this._setValue(defaults, 'iast.telemetryVerbosity', 'INFORMATION')
    this._setValue(defaults, 'iast.redactionNamePattern', null)
    this._setValue(defaults, 'iast.redactionValuePattern', null)
    this._setBoolean(defaults, 'isCiVisibility', false)
    this._setBoolean(defaults, 'isIntelligentTestRunnerEnabled', false)
    this._setBoolean(defaults, 'isManualApiEnabled', false)
    this._setBoolean(defaults, 'stats.enabled', false)
    this._setBoolean(defaults, 'isGitUploadEnabled', false)
    this._setBoolean(defaults, 'gitMetadataEnabled', true)
    this._setBoolean(defaults, 'isGCPFunction', false)
    this._setValue(defaults, 'openaiSpanCharLimit', 128)
    this._setBoolean(defaults, 'traceId128BitGenerationEnabled', true)
    this._setBoolean(defaults, 'traceId128BitLoggingEnabled', false)
  }

  _applyEnvironment (options) {
    const {
      DD_ENV,
      DD_LOGS_INJECTION,
      DD_SERVICE,
      DD_SERVICE_NAME,
      DD_TAGS,
      DD_TRACE_GLOBAL_TAGS,
      DD_TRACE_HEADER_TAGS,
      DD_TRACE_SAMPLE_RATE,
      DD_TRACE_TAGS,
      DD_VERSION,
      DD_TRACING_ENABLED,
      DD_DBM_PROPAGATION_MODE,
      DD_DATA_STREAMS_ENABLED,
      DD_OPENAI_LOGS_ENABLED,
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
      AWS_LAMBDA_FUNCTION_NAME,
      FUNCTION_NAME,
      K_SERVICE,
      WEBSITE_SITE_NAME,
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
      DD_TRACE_PEER_SERVICE_MAPPING,
      DD_TRACE_STARTUP_LOGS,
      DD_TELEMETRY_LOG_COLLECTION_ENABLED,
      DD_TELEMETRY_HEARTBEAT_INTERVAL,
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
      DD_IAST_ENABLED,
      DD_IAST_REQUEST_SAMPLING,
      DD_IAST_MAX_CONCURRENT_REQUESTS,
      DD_IAST_MAX_CONTEXT_OPERATIONS,
      DD_IAST_DEDUPLICATION_ENABLED,
      DD_IAST_REDACTION_ENABLED,
      DD_IAST_TELEMETRY_VERBOSITY,
      DD_IAST_REDACTION_NAME_PATTERN,
      DD_IAST_REDACTION_VALUE_PATTERN,
      DD_TRACE_GIT_METADATA_ENABLED,
      DD_OPENAI_SPAN_CHAR_LIMIT,
      DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED,
      DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED
    } = process.env

    const tags = {}
    const env = this._env = {}

    tagger.add(tags, DD_TAGS)
    tagger.add(tags, DD_TRACE_TAGS)
    tagger.add(tags, DD_TRACE_GLOBAL_TAGS)

    this._setString(env, 'service', DD_SERVICE || DD_SERVICE_NAME || tags.service)
    this._setString(env, 'env', DD_ENV || tags.env)
    this._setString(env, 'version', DD_VERSION || tags.version)
    this._setUnit(env, 'sampleRate', DD_TRACE_SAMPLE_RATE)
    this._setBoolean(env, 'logInjection', DD_LOGS_INJECTION)
    this._setArray(env, 'headerTags', DD_TRACE_HEADER_TAGS)
    this._setTags(env, 'tags', tags)
    this._setBoolean(env, 'tracing', !isFalse(DD_TRACING_ENABLED))
    this._setString(env, 'dbmPropagationMode', DD_DBM_PROPAGATION_MODE)
    this._setBoolean(env, 'dsmEnabled', DD_DATA_STREAMS_ENABLED)
    this._setBoolean(env, 'openAiLogsEnabled', DD_OPENAI_LOGS_ENABLED)
    if (DD_CIVISIBILITY_AGENTLESS_URL) {
      this._setValue(env, 'url', new URL(DD_CIVISIBILITY_AGENTLESS_URL))
    } else {
      this._setValue(env, 'url', getAgentUrl(coalesce(DD_TRACE_AGENT_URL, DD_TRACE_URL, null), options))
    }
    this._setString(env, 'site', DD_SITE)
    this._setString(env, 'hostname', coalesce(DD_AGENT_HOST, DD_TRACE_AGENT_HOSTNAME))
    if (DD_TRACE_AGENT_PORT) this._setValue(env, 'port', String(DD_TRACE_AGENT_PORT))
    this._setValue(env, 'flushMinSpans', maybeInt(DD_TRACE_PARTIAL_FLUSH_MIN_SPANS))
    this._setString(env, 'queryStringObfuscation', DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP)
    this._setBoolean(env, 'clientIpEnabled', DD_TRACE_CLIENT_IP_ENABLED)
    this._setString(env, 'clientIpHeader', DD_TRACE_CLIENT_IP_HEADER)
    this._setString(env, 'service',
      DD_SERVICE || DD_SERVICE_NAME || AWS_LAMBDA_FUNCTION_NAME || FUNCTION_NAME || K_SERVICE || WEBSITE_SITE_NAME)
    this._setValue(env, 'flushMinSpans', maybeInt(DD_TRACE_PARTIAL_FLUSH_MIN_SPANS))
    this._setString(env, 'queryStringObfuscation', DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP)
    this._setBoolean(env, 'clientIpEnabled', DD_TRACE_CLIENT_IP_ENABLED)
    this._setString(env, 'clientIpHeader', DD_TRACE_CLIENT_IP_HEADER)
    if (DD_DOGSTATSD_PORT) this._setString(env, 'dogstatsd.port', String(DD_DOGSTATSD_PORT))
    this._setString(env, 'dogstatsd.hostname', DD_DOGSTATSD_HOSTNAME)
    this._setBoolean(env, 'runtimeMetrics', DD_RUNTIME_METRICS_ENABLED)
    this._setBoolean(env, 'experimental.runtimeId', DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED)
    this._setString(env, 'experimental.exporter', DD_TRACE_EXPERIMENTAL_EXPORTER)
    this._setBoolean(env, 'experimental.enableGetRumData', DD_TRACE_EXPERIMENTAL_GET_RUM_DATA_ENABLED)
    this._setValue(env, 'sampler.rateLimit', DD_TRACE_RATE_LIMIT)
    this._setBoolean(env, 'reportHostname', DD_TRACE_REPORT_HOSTNAME)
    this._setString(env, 'scope', DD_TRACE_SCOPE)
    this._setBoolean(env, 'profiling.enabled', coalesce(DD_EXPERIMENTAL_PROFILING_ENABLED, DD_PROFILING_ENABLED))
    this._setBoolean(env, 'profiling.sourceMap', DD_PROFILING_SOURCE_MAP && !isFalse(DD_PROFILING_SOURCE_MAP))
    this._setString(env, 'profiling.exporters', DD_PROFILING_EXPORTERS)
    if (DD_TRACE_SPAN_ATTRIBUTE_SCHEMA) {
      this._setString(env, 'spanAttributeSchema', validateNamingVersion(DD_TRACE_SPAN_ATTRIBUTE_SCHEMA))
    }
    this._setBoolean(env, 'spanRemoveIntegrationFromService', DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED)
    if (DD_TRACE_PEER_SERVICE_MAPPING) {
      this._setString(env, 'peerServiceMapping', fromEntries(
        process.env.DD_TRACE_PEER_SERVICE_MAPPING.split(',').map(x => x.trim().split(':'))
      ))
    }
    this._setBoolean(env, 'startupLogs', DD_TRACE_STARTUP_LOGS)
    this._setBoolean(env, 'telemetry.enabled', this.DD_INSTRUMENTATION_TELEMETRY_ENABLED)
    this._setBoolean(env, 'telemetry.logCollection', coalesce(DD_TELEMETRY_LOG_COLLECTION_ENABLED, DD_IAST_ENABLED))
    this._setValue(env, 'telemetry.heartbeatInterval', maybeInt(Math.floor(DD_TELEMETRY_HEARTBEAT_INTERVAL * 1000)))
    this._setBoolean(env, 'telemetry.debug', DD_TELEMETRY_DEBUG)
    this._setBoolean(env, 'telemetry.metrics', DD_TELEMETRY_METRICS_ENABLED)
    this._setBoolean(env, 'telemetry.dependencyCollection', DD_TELEMETRY_DEPENDENCY_COLLECTION_ENABLED)
    this._setString(env, 'protocolVersion', DD_TRACE_AGENT_PROTOCOL_VERSION)
    this._setValue(env, 'tagsHeaderMaxLength', DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH)
    this._setBoolean(env, 'appsec.enabled', DD_APPSEC_ENABLED && isTrue(DD_APPSEC_ENABLED))
    this._setString(env, 'appsec.rules', DD_APPSEC_RULES)
    if (DD_APPSEC_RULES) this._setBoolean(env, 'appsec.customRulesProvided', !!DD_APPSEC_RULES)
    this._setValue(env, 'appsec.rateLimit', maybeInt(DD_APPSEC_TRACE_RATE_LIMIT))
    this._setValue(env, 'appsec.wafTimeout', maybeInt(DD_APPSEC_WAF_TIMEOUT))
    this._setString(env, 'appsec.obfuscatorKeyRegex', DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP)
    this._setString(env, 'appsec.obfuscatorValueRegex', DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP)
    this._setValue(env, 'appsec.blockedTemplateHtml', maybeFile(DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML))
    this._setValue(env, 'appsec.blockedTemplateJson', maybeFile(DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON))
    this._setBoolean(env, 'remoteConfig.enabled', this.DD_REMOTE_CONFIGURATION_ENABLED)
    this._setValue(env, 'remoteConfig.pollInterval', maybeFloat(DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS))
    this._setBoolean(env, 'iast.enabled', DD_IAST_ENABLED)
    const iastRequestSampling = maybeInt(DD_IAST_REQUEST_SAMPLING)
    if (iastRequestSampling > -1 && iastRequestSampling < 101) {
      this._setValue(env, 'iast.requestSampling', iastRequestSampling)
    }
    this._setValue(env, 'iast.maxConcurrentRequests', maybeInt(DD_IAST_MAX_CONCURRENT_REQUESTS))
    this._setValue(env, 'iast.maxContextOperations', maybeInt(DD_IAST_MAX_CONTEXT_OPERATIONS))
    this._setBoolean(env, 'iast.deduplicationEnabled',
      DD_IAST_DEDUPLICATION_ENABLED && isTrue(DD_IAST_DEDUPLICATION_ENABLED))
    this._setBoolean(env, 'iast.redactionEnabled', DD_IAST_REDACTION_ENABLED && !isFalse(DD_IAST_REDACTION_ENABLED))
    this._setString(env, 'iast.telemetryVerbosity', DD_IAST_TELEMETRY_VERBOSITY)
    this._setString(env, 'iast.redactionNamePattern', DD_IAST_REDACTION_NAME_PATTERN)
    this._setString(env, 'iast.redactionValuePattern', DD_IAST_REDACTION_VALUE_PATTERN)
    this._setBoolean(env, 'gitMetadataEnabled', DD_TRACE_GIT_METADATA_ENABLED)
    this._setBoolean(env, 'isGCPFunction', getIsGCPFunction())
    this._setValue(env, 'openaiSpanCharLimit', maybeInt(DD_OPENAI_SPAN_CHAR_LIMIT))
    this._setBoolean(env, 'traceId128BitGenerationEnabled', DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED)
    this._setBoolean(env, 'traceId128BitLoggingEnabled', DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED)
  }

  _applyOptions (options) {
    const opts = this._options = this._options || {}
    const tags = {}

    options = Object.assign({ ingestion: {} }, options, opts)

    tagger.add(tags, options.tags)

    this._setString(opts, 'service', options.service || tags.service)
    this._setString(opts, 'env', options.env || tags.env)
    this._setString(opts, 'version', options.version || tags.version)
    this._setUnit(opts, 'sampleRate', coalesce(options.sampleRate, options.ingestion.sampleRate))
    this._setBoolean(opts, 'logInjection', options.logInjection)
    this._setArray(opts, 'headerTags', options.headerTags)
    this._setTags(opts, 'tags', tags)
    this._setString(opts, 'dbmPropagationMode', options.dbmPropagationMode)
    this._setBoolean(opts, 'dsmEnabled', options.dsmEnabled)
    this._setBoolean(opts, 'openAiLogsEnabled', options.openAiLogsEnabled)
    if (options.url) this._setValue(opts, 'url', getAgentUrl(options.url, options))
    this._setString(opts, 'site', options.site)
    this._setString(opts, 'hostname', options.hostname)
    if (options.port) this._setString(opts, 'port', String(options.port))
    // if (parseInt(options.flushInterval, 10))
    // this._setValue(opts, 'flushInterval', parseInt(options.flushInterval, 10))
    this._setValue(opts, 'flushMinSpans', maybeInt(options.flushMinSpans))
    this._setBoolean(opts, 'clientIpEnabled', options.clientIpEnabled)
    this._setString(opts, 'clientIpHeader', options.clientIpHeader)
    this._setBoolean(opts, 'plugins', options.plugins)
    if (options.dogstatsd) {
      this._setString(opts, 'dogstatsd.port', String(options.dogstatsd.port))
      this._setString(opts, 'dogstatsd.hostname', options.dogstatsd.hostname)
    }
    this._setBoolean(opts, 'runtimeMetrics', options.runtimeMetrics)
    this._setBoolean(opts, 'experimental.runtimeId', options.experimental && options.experimental.runtimeId)
    this._setString(opts, 'experimental.exporter', options.experimental && options.experimental.exporter)
    this._setBoolean(opts, 'experimental.enableGetRumData',
      options.experimental && options.experimental.enableGetRumData)
    const ingestion = options.ingestion || {}
    this._setValue(opts, 'sampler.rateLimit', coalesce(options.rateLimit, ingestion.rateLimit))
    this._setBoolean(opts, 'reportHostname', options.reportHostname)
    this._setBoolean(opts, 'profiling.enabled', options.profiling)
    if (options.spanAttributeSchema) {
      this._setString(opts, 'spanAttributeSchema', validateNamingVersion(options.spanAttributeSchema))
    }
    this._setBoolean(opts, 'spanRemoveIntegrationFromService', options.spanRemoveIntegrationFromService)
    this._setString(opts, 'peerServiceMapping', options.peerServiceMapping)
    this._setString(opts, 'lookup', options.lookup)
    this._setBoolean(opts, 'startupLogs', options.startupLogs)
    this._setBoolean(opts, 'telemetry.logCollection', this.iastOptions &&
    (this.iastOptions === true || this.iastOptions.enabled === true))
    this._setString(opts, 'protocolVersion', options.protocolVersion)
    this._setBoolean(opts, 'appsec.enabled', this.appsecOpt.enabled)
    this._setString(opts, 'appsec.rules', this.appsecOpt.rules)
    if (this.appsecOpt.rules) this._setBoolean(opts, 'appsec.customRulesProvided', !!this.appsecOpt.rules)
    this._setValue(opts, 'appsec.rateLimit', maybeInt(this.appsecOpt.rateLimit))
    this._setValue(opts, 'appsec.wafTimeout', maybeInt(this.appsecOpt.wafTimeout))
    this._setString(opts, 'appsec.obfuscatorKeyRegex', this.appsecOpt.obfuscatorKeyRegex)
    this._setString(opts, 'appsec.obfuscatorValueRegex', this.appsecOpt.obfuscatorValueRegex)
    this._setValue(opts, 'appsec.blockedTemplateHtml', maybeFile(this.appsecOpt.blockedTemplateHtml))
    this._setValue(opts, 'appsec.blockedTemplateJson', maybeFile(this.appsecOpt.blockedTemplateJson))
    if (options.remoteConfig) {
      this._setValue(opts, 'remoteConfig.pollInterval', maybeFloat(options.remoteConfig.pollInterval))
    }
    this._setBoolean(opts, 'iast.enabled',
      this.iastOptions && (this.iastOptions === true || this.iastOptions.enabled === true))
    const iastRequestSampling = maybeInt(this.iastOptions?.requestSampling)
    if (iastRequestSampling > -1 && iastRequestSampling < 101) {
      this._setValue(opts, 'iast.requestSampling', iastRequestSampling)
    }
    this._setValue(opts, 'iast.maxConcurrentRequests',
      maybeInt(this.iastOptions?.maxConcurrentRequests))
    this._setValue(opts, 'iast.maxContextOperations',
      maybeInt(this.iastOptions && this.iastOptions.maxContextOperations))
    this._setBoolean(opts, 'iast.deduplicationEnabled', this.iastOptions && this.iastOptions.deduplicationEnabled)
    this._setBoolean(opts, 'iast.redactionEnabled', this.iastOptions && this.iastOptions.redactionEnabled)
    this._setString(opts, 'iast.telemetryVerbosity', this.iastOptions && this.iastOptions.telemetryVerbosity)
    this._setString(opts, 'iast.redactionNamePattern', this.iastOptions?.redactionNamePattern)
    this._setString(opts, 'iast.redactionValuePattern', this.iastOptions?.redactionValuePattern)
    this._setBoolean(opts, 'isCiVisibility', options.isCiVisibility)
    this._setBoolean(opts, 'traceId128BitGenerationEnabled', options.traceId128BitGenerationEnabled)
    this._setBoolean(opts, 'traceId128BitLoggingEnabled', options.traceId128BitLoggingEnabled)
  }

  // currently does not support dynamic/remote config
  _applyCalculated (options) {
    const calc = this._calculated = {}

    const DD_TRACE_EXPORTER = options.experimental && options.experimental.exporter
    if (DD_TRACE_EXPORTER === 'datadog') {
      this._setBoolean(calc, 'telemetry.enabled', false)
    }
    this._setString(calc, 'dogstatsd.hostname', this.HOSTNAME)
    this._setString(calc, 'spanComputePeerService', this.DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED)
    this._setBoolean(calc, 'isIntelligentTestRunnerEnabled',
      isTrue(this.DD_IS_CIVISIBILITY) && isTrue(this.DD_CIVISIBILITY_ITR_ENABLED))
    this._setBoolean(calc, 'isGitUploadEnabled',
      calc['isIntelligentTestRunnerEnabled'] && !isFalse(this.DD_CIVISIBILITY_GIT_UPLOAD_ENABLED))
    this._setBoolean(calc, 'isManualApiEnabled',
      isTrue(this.DD_IS_CIVISIBILITY) && isTrue(this.DD_CIVISIBILITY_MANUAL_API_ENABLED))
    this._setBoolean(calc, 'stats.enabled', this.DD_TRACE_STATS_COMPUTATION_ENABLED)
  }

  _applyRemote (options) {
    const opts = this._remote = this._remote || {}
    const tags = {}
    const headerTags = options.tracing_header_tags
      ? options.tracing_header_tags.map(tag => {
        return tag.tag_name ? `${tag.header}:${tag.tag_name}` : tag.header
      })
      : undefined

    tagger.add(tags, options.tracing_tags)

    this._setUnit(opts, 'sampleRate', options.tracing_sampling_rate)
    this._setBoolean(opts, 'logInjection', options.log_injection_enabled)
    this._setArray(opts, 'headerTags', headerTags)
    this._setTags(opts, 'tags', tags)
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

  _setString (obj, name, value) {
    obj[name] = value || undefined // unset for empty strings
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
  _merge () {
    const containers = [this._remote, this._options, this._env, this._calculated, this._defaults]
    const origins = ['remote_config', 'code', 'env_var', 'calculated', 'default']
    const changes = []

    for (const name in this._defaults) {
      for (let i = 0; i < containers.length; i++) {
        const container = containers[i]
        const origin = origins[i]

        if ((container[name] !== null && container[name] !== undefined) || container === this._defaults) {
          if (this._getConfigValue(name) === container[name] && this._existsPropertyName(name)) break

          let value = container[name]
          this._setConfigValue(name, value)

          if (name === 'url') value = value.toString()
          if (name === 'appsec.rules') value = JSON.stringify(value)
          if (name === 'peerServiceMapping' || name === 'tags') value = formatMapForTelemetry(value)
          if (name === 'headerTags') value = value.toString()

          changes.push({ name, value, origin })

          break
        }
      }
    }

    this.sampler.sampleRate = this.sampleRate
    updateConfig(changes, this)

    return changes
  }

  _getConfigValue (name) {
    const nameArr = name.split('.')
    let val = this
    for (const n in nameArr) {
      if (val === undefined) return val
      val = val[nameArr[n]]
    }
    return val
  }

  _setConfigValue (name, value) {
    const nameArr = name.split('.')
    let property = this
    let i
    for (i = 0; i < nameArr.length - 1; i++) {
      const n = nameArr[i]
      if (property.hasOwnProperty(n)) {
        property = property[n]
      } else {
        property[n] = {}
        property = property[n]
      }
    }
    property[nameArr[i]] = value
  }

  _existsPropertyName (name) {
    const nameArr = name.split('.')
    let property = this
    let i
    for (i = 0; i < nameArr.length - 1; i++) {
      const n = nameArr[i]
      if (property.hasOwnProperty(n)) {
        property = property[n]
      } else {
        return false
      }
    }
    if (property.hasOwnProperty(nameArr[i])) return true
    return false
  }
}

function maybeInt (number) {
  if (!isNaN(parseInt(number))) {
    return parseInt(number)
  }
  return undefined
}

function maybeFloat (number) {
  if (!isNaN(parseFloat(number))) {
    return parseFloat(number)
  }
  return undefined
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

function formatMapForTelemetry (map) {
  // format from an object to a string map in order for
  // telemetry intake to accept the configuration
  return map
    ? Object.entries(map).map(([key, value]) => `${key}:${value}`).join(',')
    : ''
}

module.exports = Config
