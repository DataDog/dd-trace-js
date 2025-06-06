'use strict'

const fs = require('fs')
const os = require('os')
const uuid = require('crypto-randomuuid') // we need to keep the old uuid dep because of cypress
const { URL } = require('url')
const log = require('./log')
const pkg = require('./pkg')
const coalesce = require('koalas')
const tagger = require('./tagger')
const get = require('../../datadog-core/src/utils/src/get')
const has = require('../../datadog-core/src/utils/src/has')
const set = require('../../datadog-core/src/utils/src/set')
const { isTrue, isFalse, normalizeProfilingEnabledValue } = require('./util')
const { GIT_REPOSITORY_URL, GIT_COMMIT_SHA } = require('./plugins/util/tags')
const { getGitMetadataFromGitProperties, removeUserSensitiveInfo } = require('./git_properties')
const { updateConfig } = require('./telemetry')
const telemetryMetrics = require('./telemetry/metrics')
const { isInServerlessEnvironment, getIsGCPFunction, getIsAzureFunction } = require('./serverless')
const { ORIGIN_KEY, GRPC_CLIENT_ERROR_STATUSES, GRPC_SERVER_ERROR_STATUSES } = require('./constants')
const { appendRules } = require('./payload-tagging/config')

const tracerMetrics = telemetryMetrics.manager.namespace('tracers')

const telemetryCounters = {
  'otel.env.hiding': {},
  'otel.env.invalid': {}
}

function getCounter (event, ddVar, otelVar) {
  const counters = telemetryCounters[event]
  const tags = []
  const ddVarPrefix = 'config_datadog:'
  const otelVarPrefix = 'config_opentelemetry:'
  if (ddVar) {
    ddVar = ddVarPrefix + ddVar.toLowerCase()
    tags.push(ddVar)
  }
  if (otelVar) {
    otelVar = otelVarPrefix + otelVar.toLowerCase()
    tags.push(otelVar)
  }

  if (!(otelVar in counters)) counters[otelVar] = {}

  const counter = tracerMetrics.count(event, tags)
  counters[otelVar][ddVar] = counter
  return counter
}

const otelDdEnvMapping = {
  OTEL_LOG_LEVEL: 'DD_TRACE_LOG_LEVEL',
  OTEL_PROPAGATORS: 'DD_TRACE_PROPAGATION_STYLE',
  OTEL_SERVICE_NAME: 'DD_SERVICE',
  OTEL_TRACES_SAMPLER: 'DD_TRACE_SAMPLE_RATE',
  OTEL_TRACES_SAMPLER_ARG: 'DD_TRACE_SAMPLE_RATE',
  OTEL_TRACES_EXPORTER: 'DD_TRACE_ENABLED',
  OTEL_METRICS_EXPORTER: 'DD_RUNTIME_METRICS_ENABLED',
  OTEL_RESOURCE_ATTRIBUTES: 'DD_TAGS',
  OTEL_SDK_DISABLED: 'DD_TRACE_OTEL_ENABLED',
  OTEL_LOGS_EXPORTER: undefined
}

const VALID_PROPAGATION_STYLES = new Set(['datadog', 'tracecontext', 'b3', 'b3 single header', 'none'])

const VALID_PROPAGATION_BEHAVIOR_EXTRACT = new Set(['continue', 'restart', 'ignore'])

const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error'])

function getFromOtelSamplerMap (otelTracesSampler, otelTracesSamplerArg) {
  const OTEL_TRACES_SAMPLER_MAPPING = {
    always_on: '1.0',
    always_off: '0.0',
    traceidratio: otelTracesSamplerArg,
    parentbased_always_on: '1.0',
    parentbased_always_off: '0.0',
    parentbased_traceidratio: otelTracesSamplerArg
  }
  return OTEL_TRACES_SAMPLER_MAPPING[otelTracesSampler]
}

function validateOtelPropagators (propagators) {
  if (!process.env.PROPAGATION_STYLE_EXTRACT &&
    !process.env.PROPAGATION_STYLE_INJECT &&
    !process.env.DD_TRACE_PROPAGATION_STYLE &&
    process.env.OTEL_PROPAGATORS) {
    for (const style in propagators) {
      if (!VALID_PROPAGATION_STYLES.has(style)) {
        log.warn('unexpected value for OTEL_PROPAGATORS environment variable')
        getCounter('otel.env.invalid', 'DD_TRACE_PROPAGATION_STYLE', 'OTEL_PROPAGATORS').inc()
      }
    }
  }
}

function validateEnvVarType (envVar) {
  const value = process.env[envVar]
  switch (envVar) {
    case 'OTEL_LOG_LEVEL':
      return VALID_LOG_LEVELS.has(value)
    case 'OTEL_PROPAGATORS':
    case 'OTEL_RESOURCE_ATTRIBUTES':
    case 'OTEL_SERVICE_NAME':
      return typeof value === 'string'
    case 'OTEL_TRACES_SAMPLER':
      return getFromOtelSamplerMap(value, process.env.OTEL_TRACES_SAMPLER_ARG) !== undefined
    case 'OTEL_TRACES_SAMPLER_ARG':
      return !Number.isNaN(Number.parseFloat(value))
    case 'OTEL_SDK_DISABLED':
      return value.toLowerCase() === 'true' || value.toLowerCase() === 'false'
    case 'OTEL_TRACES_EXPORTER':
    case 'OTEL_METRICS_EXPORTER':
    case 'OTEL_LOGS_EXPORTER':
      return value.toLowerCase() === 'none'
    default:
      return false
  }
}

function checkIfBothOtelAndDdEnvVarSet () {
  for (const [otelEnvVar, ddEnvVar] of Object.entries(otelDdEnvMapping)) {
    if (ddEnvVar && process.env[ddEnvVar] && process.env[otelEnvVar]) {
      log.warn(`both ${ddEnvVar} and ${otelEnvVar} environment variables are set`)
      getCounter('otel.env.hiding', ddEnvVar, otelEnvVar).inc()
    }

    if (process.env[otelEnvVar] && !validateEnvVarType(otelEnvVar)) {
      log.warn(`unexpected value for ${otelEnvVar} environment variable`)
      getCounter('otel.env.invalid', ddEnvVar, otelEnvVar).inc()
    }
  }
}

// eslint-disable-next-line @stylistic/max-len
const qsRegex = String.raw`(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?|access_?|secret_?)key(?:_?id)?|token|consumer_?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?)(?:(?:\s|%20)*(?:=|%3D)[^&]+|(?:"|%22)(?:\s|%20)*(?::|%3A)(?:\s|%20)*(?:"|%22)(?:%2[^2]|%[^2]|[^"%])+(?:"|%22))|bearer(?:\s|%20)+[a-z0-9\._\-]+|token(?::|%3A)[a-z0-9]{13}|gh[opsu]_[0-9a-zA-Z]{36}|ey[I-L](?:[\w=-]|%3D)+\.ey[I-L](?:[\w=-]|%3D)+(?:\.(?:[\w.+\/=-]|%3D|%2F|%2B)+)?|[\-]{5}BEGIN(?:[a-z\s]|%20)+PRIVATE(?:\s|%20)KEY[\-]{5}[^\-]+[\-]{5}END(?:[a-z\s]|%20)+PRIVATE(?:\s|%20)KEY|ssh-rsa(?:\s|%20)*(?:[a-z0-9\/\.+]|%2F|%5C|%2B){100,}`
// eslint-disable-next-line @stylistic/max-len
const defaultWafObfuscatorKeyRegex = String.raw`(?i)pass|pw(?:or)?d|secret|(?:api|private|public|access)[_-]?key|token|consumer[_-]?(?:id|key|secret)|sign(?:ed|ature)|bearer|authorization|jsessionid|phpsessid|asp\.net[_-]sessionid|sid|jwt`
// eslint-disable-next-line @stylistic/max-len
const defaultWafObfuscatorValueRegex = String.raw`(?i)(?:p(?:ass)?w(?:or)?d|pass(?:[_-]?phrase)?|secret(?:[_-]?key)?|(?:(?:api|private|public|access)[_-]?)key(?:[_-]?id)?|(?:(?:auth|access|id|refresh)[_-]?)?token|consumer[_-]?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?|jsessionid|phpsessid|asp\.net(?:[_-]|-)sessionid|sid|jwt)(?:\s*=([^;&]+)|"\s*:\s*("[^"]+"|\d+))|bearer\s+([a-z0-9\._\-]+)|token\s*:\s*([a-z0-9]{13})|gh[opsu]_([0-9a-zA-Z]{36})|ey[I-L][\w=-]+\.(ey[I-L][\w=-]+(?:\.[\w.+\/=-]+)?)|[\-]{5}BEGIN[a-z\s]+PRIVATE\sKEY[\-]{5}([^\-]+)[\-]{5}END[a-z\s]+PRIVATE\sKEY|ssh-rsa\s*([a-z0-9\/\.+]{100,})`
const runtimeId = uuid()

function maybeFile (filepath) {
  if (!filepath) return
  try {
    return fs.readFileSync(filepath, 'utf8')
  } catch (e) {
    log.error('Error reading file %s', filepath, e)
  }
}

function safeJsonParse (input) {
  try {
    return JSON.parse(input)
  } catch {}
}

const namingVersions = new Set(['v0', 'v1'])
const defaultNamingVersion = 'v0'

function validateNamingVersion (versionString) {
  if (!versionString) {
    return defaultNamingVersion
  }
  if (!namingVersions.has(versionString)) {
    log.warn(
      `Unexpected input for config.spanAttributeSchema, picked default ${defaultNamingVersion}`
    )
    return defaultNamingVersion
  }
  return versionString
}

/**
 * Given a string of comma-separated paths, return the array of paths.
 * If a blank path is provided a null is returned to signal that the feature is disabled.
 * An empty array means the feature is enabled but that no rules need to be applied.
 *
 * @param {string | string[]} input
 */
function splitJSONPathRules (input) {
  if (!input) return
  if (Array.isArray(input)) return input
  if (input === 'all') return []
  return input.split(',')
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

function propagationStyle (key, option) {
  // Extract by key if in object-form value
  if (option !== null && typeof option === 'object' && !Array.isArray(option)) {
    option = option[key]
  }

  // Should be an array at this point
  if (Array.isArray(option)) return option.map(v => v.toLowerCase())

  // If it's not an array but not undefined there's something wrong with the input
  if (option !== undefined) {
    log.warn('Unexpected input for config.tracePropagationStyle')
  }

  // Otherwise, fallback to env var parsing
  const envKey = `DD_TRACE_PROPAGATION_STYLE_${key.toUpperCase()}`

  const envVar = coalesce(process.env[envKey], process.env.DD_TRACE_PROPAGATION_STYLE, process.env.OTEL_PROPAGATORS)
  if (envVar !== undefined) {
    return envVar.split(',')
      .filter(v => v !== '')
      .map(v => v.trim().toLowerCase())
  }
}

function reformatSpanSamplingRules (rules) {
  if (!rules) return rules
  return rules.map(rule => {
    return remapify(rule, {
      sample_rate: 'sampleRate',
      max_per_second: 'maxPerSecond'
    })
  })
}

class Config {
  constructor (options = {}) {
    if (!isInServerlessEnvironment()) {
      // Bail out early if we're in a serverless environment, stable config isn't supported
      const StableConfig = require('./config_stable')
      this.stableConfig = new StableConfig()
    }

    options = {
      ...options,
      appsec: options.appsec == null ? options.experimental?.appsec : options.appsec,
      iast: options.iast == null ? options.experimental?.iast : options.iast
    }

    // Configure the logger first so it can be used to warn about other configs
    const logConfig = log.getConfig()
    this.debug = log.isEnabled(
      this.stableConfig?.fleetEntries?.DD_TRACE_DEBUG,
      this.stableConfig?.localEntries?.DD_TRACE_DEBUG
    )
    this.logger = coalesce(options.logger, logConfig.logger)
    this.logLevel = log.getLogLevel(
      options.logLevel,
      this.stableConfig?.fleetEntries?.DD_TRACE_LOG_LEVEL,
      this.stableConfig?.localEntries?.DD_TRACE_LOG_LEVEL
    )
    log.use(this.logger)
    log.toggle(this.debug, this.logLevel)

    // Process stable config warnings, if any
    for (const warning of this.stableConfig?.warnings ?? []) {
      log.warn(warning)
    }

    checkIfBothOtelAndDdEnvVarSet()

    const DD_API_KEY = coalesce(
      process.env.DATADOG_API_KEY,
      process.env.DD_API_KEY
    )

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
      options.tracePropagationStyle
    )

    validateOtelPropagators(PROPAGATION_STYLE_INJECT)

    if (typeof options.appsec === 'boolean') {
      options.appsec = {
        enabled: options.appsec
      }
    }

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

    const DD_TRACE_CLOUD_REQUEST_PAYLOAD_TAGGING = splitJSONPathRules(
      coalesce(
        process.env.DD_TRACE_CLOUD_REQUEST_PAYLOAD_TAGGING,
        options.cloudPayloadTagging?.request,
        ''
      ))

    const DD_TRACE_CLOUD_RESPONSE_PAYLOAD_TAGGING = splitJSONPathRules(
      coalesce(
        process.env.DD_TRACE_CLOUD_RESPONSE_PAYLOAD_TAGGING,
        options.cloudPayloadTagging?.response,
        ''
      ))

    const DD_TRACE_CLOUD_PAYLOAD_TAGGING_MAX_DEPTH = coalesce(
      process.env.DD_TRACE_CLOUD_PAYLOAD_TAGGING_MAX_DEPTH,
      options.cloudPayloadTagging?.maxDepth,
      10
    )

    // TODO: refactor
    this.apiKey = DD_API_KEY

    // sent in telemetry event app-started
    this.installSignature = {
      id: DD_INSTRUMENTATION_INSTALL_ID,
      time: DD_INSTRUMENTATION_INSTALL_TIME,
      type: DD_INSTRUMENTATION_INSTALL_TYPE
    }

    this.cloudPayloadTagging = {
      requestsEnabled: !!DD_TRACE_CLOUD_REQUEST_PAYLOAD_TAGGING,
      responsesEnabled: !!DD_TRACE_CLOUD_RESPONSE_PAYLOAD_TAGGING,
      maxDepth: DD_TRACE_CLOUD_PAYLOAD_TAGGING_MAX_DEPTH,
      rules: appendRules(
        DD_TRACE_CLOUD_REQUEST_PAYLOAD_TAGGING, DD_TRACE_CLOUD_RESPONSE_PAYLOAD_TAGGING
      )
    }

    this._applyDefaults()
    this._applyLocalStableConfig()
    this._applyEnvironment()
    this._applyFleetStableConfig()
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
            log.error('Error reading DD_GIT_PROPERTIES_FILE: %s', DD_GIT_PROPERTIES_FILE, e)
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

  _getDefaultPropagationStyle (options) {
    // TODO: Remove the experimental env vars as a major?
    const DD_TRACE_B3_ENABLED = coalesce(
      options.experimental && options.experimental.b3,
      process.env.DD_TRACE_EXPERIMENTAL_B3_ENABLED,
      false
    )
    const defaultPropagationStyle = ['datadog', 'tracecontext']
    if (isTrue(DD_TRACE_B3_ENABLED)) {
      defaultPropagationStyle.push('b3', 'b3 single header')
    }
    return defaultPropagationStyle
  }

  _isInServerlessEnvironment () {
    return isInServerlessEnvironment()
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

    const defaults = setHiddenProperty(this, '_defaults', {})

    defaults.apmTracingEnabled = true
    defaults['appsec.apiSecurity.enabled'] = true
    defaults['appsec.apiSecurity.sampleDelay'] = 30
    defaults['appsec.blockedTemplateGraphql'] = undefined
    defaults['appsec.blockedTemplateHtml'] = undefined
    defaults['appsec.blockedTemplateJson'] = undefined
    defaults['appsec.enabled'] = undefined
    defaults['appsec.eventTracking.mode'] = 'identification'
    defaults['appsec.extendedHeadersCollection.enabled'] = false
    defaults['appsec.extendedHeadersCollection.redaction'] = true
    defaults['appsec.extendedHeadersCollection.maxHeaders'] = 50
    defaults['appsec.obfuscatorKeyRegex'] = defaultWafObfuscatorKeyRegex
    defaults['appsec.obfuscatorValueRegex'] = defaultWafObfuscatorValueRegex
    defaults['appsec.rasp.enabled'] = true
    defaults['appsec.rasp.bodyCollection'] = false
    defaults['appsec.rateLimit'] = 100
    defaults['appsec.rules'] = undefined
    defaults['appsec.sca.enabled'] = null
    defaults['appsec.stackTrace.enabled'] = true
    defaults['appsec.stackTrace.maxDepth'] = 32
    defaults['appsec.stackTrace.maxStackTraces'] = 2
    defaults['appsec.wafTimeout'] = 5e3 // µs
    defaults.baggageMaxBytes = 8192
    defaults.baggageMaxItems = 64
    defaults.baggageTagKeys = 'user.id,session.id,account.id'
    defaults.ciVisibilityTestSessionName = ''
    defaults.clientIpEnabled = false
    defaults.clientIpHeader = null
    defaults['crashtracking.enabled'] = true
    defaults['codeOriginForSpans.enabled'] = true
    defaults['codeOriginForSpans.experimental.exit_spans.enabled'] = false
    defaults.dbmPropagationMode = 'disabled'
    defaults['dogstatsd.hostname'] = '127.0.0.1'
    defaults['dogstatsd.port'] = '8125'
    defaults.dsmEnabled = false
    defaults['dynamicInstrumentation.enabled'] = false
    defaults['dynamicInstrumentation.redactedIdentifiers'] = []
    defaults['dynamicInstrumentation.redactionExcludedIdentifiers'] = []
    defaults.env = undefined
    defaults['experimental.enableGetRumData'] = false
    defaults['experimental.exporter'] = undefined
    defaults['experimental.runtimeId'] = false
    defaults.flushInterval = 2000
    defaults.flushMinSpans = 1000
    defaults.gitMetadataEnabled = true
    defaults.graphqlErrorExtensions = []
    defaults['grpc.client.error.statuses'] = GRPC_CLIENT_ERROR_STATUSES
    defaults['grpc.server.error.statuses'] = GRPC_SERVER_ERROR_STATUSES
    defaults.headerTags = []
    defaults.hostname = '127.0.0.1'
    defaults['iast.dbRowsToTaint'] = 1
    defaults['iast.deduplicationEnabled'] = true
    defaults['iast.enabled'] = false
    defaults['iast.maxConcurrentRequests'] = 2
    defaults['iast.maxContextOperations'] = 2
    defaults['iast.redactionEnabled'] = true
    defaults['iast.redactionNamePattern'] = null
    defaults['iast.redactionValuePattern'] = null
    defaults['iast.requestSampling'] = 30
    defaults['iast.securityControlsConfiguration'] = null
    defaults['iast.telemetryVerbosity'] = 'INFORMATION'
    defaults['iast.stackTrace.enabled'] = true
    defaults.injectionEnabled = []
    defaults.isAzureFunction = false
    defaults.isCiVisibility = false
    defaults.isEarlyFlakeDetectionEnabled = false
    defaults.isFlakyTestRetriesEnabled = false
    defaults.flakyTestRetriesCount = 5
    defaults.isGCPFunction = false
    defaults.isGitUploadEnabled = false
    defaults.isIntelligentTestRunnerEnabled = false
    defaults.isManualApiEnabled = false
    defaults['langchain.spanCharLimit'] = 128
    defaults['langchain.spanPromptCompletionSampleRate'] = 1
    defaults['llmobs.agentlessEnabled'] = undefined
    defaults['llmobs.enabled'] = false
    defaults['llmobs.mlApp'] = undefined
    defaults.ciVisibilityTestSessionName = ''
    defaults.ciVisAgentlessLogSubmissionEnabled = false
    defaults.legacyBaggageEnabled = true
    defaults.isTestDynamicInstrumentationEnabled = false
    defaults.isServiceUserProvided = false
    defaults.testManagementAttemptToFixRetries = 20
    defaults.isTestManagementEnabled = false
    defaults.isImpactedTestsEnabled = false
    defaults.logInjection = false
    defaults.lookup = undefined
    defaults.inferredProxyServicesEnabled = false
    defaults.memcachedCommandEnabled = false
    defaults.middlewareTracingEnabled = true
    defaults.openAiLogsEnabled = false
    defaults['openai.spanCharLimit'] = 128
    defaults.peerServiceMapping = {}
    defaults.plugins = true
    defaults.port = '8126'
    defaults['profiling.enabled'] = undefined
    defaults['profiling.exporters'] = 'agent'
    defaults['profiling.sourceMap'] = true
    defaults['profiling.longLivedThreshold'] = undefined
    defaults.protocolVersion = '0.4'
    defaults.queryStringObfuscation = qsRegex
    defaults['remoteConfig.enabled'] = true
    defaults['remoteConfig.pollInterval'] = 5 // seconds
    defaults.reportHostname = false
    defaults.runtimeMetrics = false
    defaults.sampleRate = undefined
    defaults['sampler.rateLimit'] = 100
    defaults['sampler.rules'] = []
    defaults['sampler.spanSamplingRules'] = []
    defaults.scope = undefined
    defaults.service = service
    defaults.serviceMapping = {}
    defaults.site = 'datadoghq.com'
    defaults.spanAttributeSchema = 'v0'
    defaults.spanComputePeerService = false
    defaults.spanLeakDebug = 0
    defaults.spanRemoveIntegrationFromService = false
    defaults.startupLogs = false
    defaults['stats.enabled'] = false
    defaults.tags = {}
    defaults.tagsHeaderMaxLength = 512
    defaults['telemetry.debug'] = false
    defaults['telemetry.dependencyCollection'] = true
    defaults['telemetry.enabled'] = true
    defaults['telemetry.heartbeatInterval'] = 60_000
    defaults['telemetry.logCollection'] = true
    defaults['telemetry.metrics'] = true
    defaults.traceEnabled = true
    defaults.traceId128BitGenerationEnabled = true
    defaults.traceId128BitLoggingEnabled = true
    defaults.tracePropagationExtractFirst = false
    defaults.tracePropagationBehaviorExtract = 'continue'
    defaults['tracePropagationStyle.inject'] = ['datadog', 'tracecontext', 'baggage']
    defaults['tracePropagationStyle.extract'] = ['datadog', 'tracecontext', 'baggage']
    defaults['tracePropagationStyle.otelPropagators'] = false
    defaults.tracing = true
    defaults.url = undefined
    defaults.version = pkg.version
    defaults.instrumentation_config_id = undefined
    defaults['vertexai.spanCharLimit'] = 128
    defaults['vertexai.spanPromptCompletionSampleRate'] = 1
    defaults['trace.aws.addSpanPointers'] = true
    defaults['trace.dynamoDb.tablePrimaryKeys'] = undefined
    defaults['trace.nativeSpanEvents'] = false
  }

  _applyLocalStableConfig () {
    const obj = setHiddenProperty(this, '_localStableConfig', {})
    this._applyStableConfig(this.stableConfig?.localEntries ?? {}, obj)
  }

  _applyFleetStableConfig () {
    const obj = setHiddenProperty(this, '_fleetStableConfig', {})
    this._applyStableConfig(this.stableConfig?.fleetEntries ?? {}, obj)
  }

  _applyStableConfig (config, obj) {
    const {
      DD_APPSEC_ENABLED,
      DD_APPSEC_SCA_ENABLED,
      DD_DATA_STREAMS_ENABLED,
      DD_DYNAMIC_INSTRUMENTATION_ENABLED,
      DD_ENV,
      DD_IAST_ENABLED,
      DD_LOGS_INJECTION,
      DD_PROFILING_ENABLED,
      DD_RUNTIME_METRICS_ENABLED,
      DD_SERVICE,
      DD_VERSION
    } = config

    obj['appsec.enabled'] = isTrue(DD_APPSEC_ENABLED)
    obj['appsec.sca.enabled'] = isTrue(DD_APPSEC_SCA_ENABLED)
    obj.dsmEnabled = isTrue(DD_DATA_STREAMS_ENABLED)
    obj['dynamicInstrumentation.enabled'] = isTrue(DD_DYNAMIC_INSTRUMENTATION_ENABLED)
    obj.env = DD_ENV
    obj['iast.enabled'] = isTrue(DD_IAST_ENABLED)
    obj.logInjection = isTrue(DD_LOGS_INJECTION)
    const profilingEnabled = normalizeProfilingEnabledValue(DD_PROFILING_ENABLED)
    obj['profiling.enabled'] = profilingEnabled
    obj.runtimeMetrics = isTrue(DD_RUNTIME_METRICS_ENABLED)
    obj.service = DD_SERVICE
    obj.version = DD_VERSION
  }

  _applyEnvironment () {
    const {
      AWS_LAMBDA_FUNCTION_NAME,
      DD_AGENT_HOST,
      DD_API_SECURITY_ENABLED,
      DD_API_SECURITY_SAMPLE_DELAY,
      DD_APM_TRACING_ENABLED,
      DD_APPSEC_AUTO_USER_INSTRUMENTATION_MODE,
      DD_APPSEC_AUTOMATED_USER_EVENTS_TRACKING,
      DD_APPSEC_COLLECT_ALL_HEADERS,
      DD_APPSEC_ENABLED,
      DD_APPSEC_GRAPHQL_BLOCKED_TEMPLATE_JSON,
      DD_APPSEC_HEADER_COLLECTION_REDACTION_ENABLED,
      DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML,
      DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON,
      DD_APPSEC_MAX_COLLECTED_HEADERS,
      DD_APPSEC_MAX_STACK_TRACES,
      DD_APPSEC_MAX_STACK_TRACE_DEPTH,
      DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP,
      DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP,
      DD_APPSEC_RULES,
      DD_APPSEC_SCA_ENABLED,
      DD_APPSEC_STACK_TRACE_ENABLED,
      DD_APPSEC_RASP_ENABLED,
      DD_APPSEC_RASP_COLLECT_REQUEST_BODY,
      DD_APPSEC_TRACE_RATE_LIMIT,
      DD_APPSEC_WAF_TIMEOUT,
      DD_CRASHTRACKING_ENABLED,
      DD_CODE_ORIGIN_FOR_SPANS_ENABLED,
      DD_CODE_ORIGIN_FOR_SPANS_EXPERIMENTAL_EXIT_SPANS_ENABLED,
      DD_DATA_STREAMS_ENABLED,
      DD_DBM_PROPAGATION_MODE,
      DD_DOGSTATSD_HOSTNAME,
      DD_DOGSTATSD_HOST,
      DD_DOGSTATSD_PORT,
      DD_DYNAMIC_INSTRUMENTATION_ENABLED,
      DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS,
      DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS,
      DD_ENV,
      DD_EXPERIMENTAL_API_SECURITY_ENABLED,
      DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED,
      DD_EXPERIMENTAL_PROFILING_ENABLED,
      DD_GRPC_CLIENT_ERROR_STATUSES,
      DD_GRPC_SERVER_ERROR_STATUSES,
      JEST_WORKER_ID,
      DD_IAST_DB_ROWS_TO_TAINT,
      DD_IAST_DEDUPLICATION_ENABLED,
      DD_IAST_ENABLED,
      DD_IAST_MAX_CONCURRENT_REQUESTS,
      DD_IAST_MAX_CONTEXT_OPERATIONS,
      DD_IAST_REDACTION_ENABLED,
      DD_IAST_REDACTION_NAME_PATTERN,
      DD_IAST_REDACTION_VALUE_PATTERN,
      DD_IAST_REQUEST_SAMPLING,
      DD_IAST_SECURITY_CONTROLS_CONFIGURATION,
      DD_IAST_TELEMETRY_VERBOSITY,
      DD_IAST_STACK_TRACE_ENABLED,
      DD_INJECTION_ENABLED,
      DD_INSTRUMENTATION_TELEMETRY_ENABLED,
      DD_INSTRUMENTATION_CONFIG_ID,
      DD_LOGS_INJECTION,
      DD_LANGCHAIN_SPAN_CHAR_LIMIT,
      DD_LANGCHAIN_SPAN_PROMPT_COMPLETION_SAMPLE_RATE,
      DD_LLMOBS_AGENTLESS_ENABLED,
      DD_LLMOBS_ENABLED,
      DD_LLMOBS_ML_APP,
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
      DD_SERVICE_MAPPING,
      DD_SERVICE_NAME,
      DD_SITE,
      DD_SPAN_SAMPLING_RULES,
      DD_SPAN_SAMPLING_RULES_FILE,
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
      DD_TRACE_AWS_ADD_SPAN_POINTERS,
      DD_TRACE_BAGGAGE_MAX_BYTES,
      DD_TRACE_BAGGAGE_MAX_ITEMS,
      DD_TRACE_BAGGAGE_TAG_KEYS,
      DD_TRACE_CLIENT_IP_ENABLED,
      DD_TRACE_CLIENT_IP_HEADER,
      DD_TRACE_DYNAMODB_TABLE_PRIMARY_KEYS,
      DD_TRACE_ENABLED,
      DD_TRACE_EXPERIMENTAL_EXPORTER,
      DD_TRACE_EXPERIMENTAL_GET_RUM_DATA_ENABLED,
      DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED,
      DD_TRACE_GIT_METADATA_ENABLED,
      DD_TRACE_GLOBAL_TAGS,
      DD_TRACE_GRAPHQL_ERROR_EXTENSIONS,
      DD_TRACE_HEADER_TAGS,
      DD_TRACE_LEGACY_BAGGAGE_ENABLED,
      DD_TRACE_MEMCACHED_COMMAND_ENABLED,
      DD_TRACE_MIDDLEWARE_TRACING_ENABLED,
      DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP,
      DD_TRACE_PARTIAL_FLUSH_MIN_SPANS,
      DD_TRACE_PEER_SERVICE_MAPPING,
      DD_TRACE_PROPAGATION_EXTRACT_FIRST,
      DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT,
      DD_TRACE_PROPAGATION_STYLE,
      DD_TRACE_PROPAGATION_STYLE_INJECT,
      DD_TRACE_PROPAGATION_STYLE_EXTRACT,
      DD_TRACE_RATE_LIMIT,
      DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED,
      DD_TRACE_REPORT_HOSTNAME,
      DD_TRACE_SAMPLE_RATE,
      DD_TRACE_SAMPLING_RULES,
      DD_TRACE_SCOPE,
      DD_TRACE_SPAN_ATTRIBUTE_SCHEMA,
      DD_TRACE_SPAN_LEAK_DEBUG,
      DD_TRACE_STARTUP_LOGS,
      DD_TRACE_TAGS,
      DD_TRACE_TELEMETRY_ENABLED,
      DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH,
      DD_TRACING_ENABLED,
      DD_VERSION,
      DD_VERTEXAI_SPAN_PROMPT_COMPLETION_SAMPLE_RATE,
      DD_VERTEXAI_SPAN_CHAR_LIMIT,
      DD_TRACE_INFERRED_PROXY_SERVICES_ENABLED,
      DD_TRACE_NATIVE_SPAN_EVENTS,
      OTEL_METRICS_EXPORTER,
      OTEL_PROPAGATORS,
      OTEL_RESOURCE_ATTRIBUTES,
      OTEL_SERVICE_NAME,
      OTEL_TRACES_SAMPLER,
      OTEL_TRACES_SAMPLER_ARG
    } = process.env

    const tags = {}
    const env = setHiddenProperty(this, '_env', {})
    setHiddenProperty(this, '_envUnprocessed', {})

    tagger.add(tags, parseSpaceSeparatedTags(handleOtel(OTEL_RESOURCE_ATTRIBUTES)))
    tagger.add(tags, parseSpaceSeparatedTags(DD_TAGS))
    tagger.add(tags, DD_TRACE_TAGS)
    tagger.add(tags, DD_TRACE_GLOBAL_TAGS)

    env.apmTracingEnabled = isTrue(coalesce(
      DD_APM_TRACING_ENABLED,
      DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED && isFalse(DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED)
    ))
    env['appsec.apiSecurity.enabled'] = isTrue(coalesce(
      DD_API_SECURITY_ENABLED && isTrue(DD_API_SECURITY_ENABLED),
      DD_EXPERIMENTAL_API_SECURITY_ENABLED && isTrue(DD_EXPERIMENTAL_API_SECURITY_ENABLED)
    ))
    env['appsec.apiSecurity.sampleDelay'] = maybeFloat(DD_API_SECURITY_SAMPLE_DELAY)
    env['appsec.blockedTemplateGraphql'] = maybeFile(DD_APPSEC_GRAPHQL_BLOCKED_TEMPLATE_JSON)
    env['appsec.blockedTemplateHtml'] = maybeFile(DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML)
    this._envUnprocessed['appsec.blockedTemplateHtml'] = DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML
    env['appsec.blockedTemplateJson'] = maybeFile(DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON)
    this._envUnprocessed['appsec.blockedTemplateJson'] = DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON
    env['appsec.enabled'] = isTrue(DD_APPSEC_ENABLED)
    env['appsec.eventTracking.mode'] = coalesce(
      DD_APPSEC_AUTO_USER_INSTRUMENTATION_MODE,
      DD_APPSEC_AUTOMATED_USER_EVENTS_TRACKING // TODO: remove in next major
    )
    env['appsec.extendedHeadersCollection.enabled'] = isTrue(DD_APPSEC_COLLECT_ALL_HEADERS)
    env['appsec.extendedHeadersCollection.redaction'] = isTrue(DD_APPSEC_HEADER_COLLECTION_REDACTION_ENABLED)
    env['appsec.extendedHeadersCollection.maxHeaders'] = maybeInt(DD_APPSEC_MAX_COLLECTED_HEADERS)
    this._envUnprocessed['appsec.extendedHeadersCollection.maxHeaders'] = DD_APPSEC_MAX_COLLECTED_HEADERS
    env['appsec.obfuscatorKeyRegex'] = DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP
    env['appsec.obfuscatorValueRegex'] = DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP
    env['appsec.rasp.enabled'] = isTrue(DD_APPSEC_RASP_ENABLED)
    env['appsec.rasp.bodyCollection'] = isTrue(DD_APPSEC_RASP_COLLECT_REQUEST_BODY)
    env['appsec.rateLimit'] = maybeInt(DD_APPSEC_TRACE_RATE_LIMIT)
    this._envUnprocessed['appsec.rateLimit'] = DD_APPSEC_TRACE_RATE_LIMIT
    env['appsec.rules'] = DD_APPSEC_RULES
    // DD_APPSEC_SCA_ENABLED is never used locally, but only sent to the backend
    env['appsec.sca.enabled'] = isTrue(DD_APPSEC_SCA_ENABLED)
    env['appsec.stackTrace.enabled'] = isTrue(DD_APPSEC_STACK_TRACE_ENABLED)
    env['appsec.stackTrace.maxDepth'] = maybeInt(DD_APPSEC_MAX_STACK_TRACE_DEPTH)
    this._envUnprocessed['appsec.stackTrace.maxDepth'] = DD_APPSEC_MAX_STACK_TRACE_DEPTH
    env['appsec.stackTrace.maxStackTraces'] = maybeInt(DD_APPSEC_MAX_STACK_TRACES)
    this._envUnprocessed['appsec.stackTrace.maxStackTraces'] = DD_APPSEC_MAX_STACK_TRACES
    env['appsec.wafTimeout'] = maybeInt(DD_APPSEC_WAF_TIMEOUT)
    this._envUnprocessed['appsec.wafTimeout'] = DD_APPSEC_WAF_TIMEOUT
    env.baggageMaxBytes = DD_TRACE_BAGGAGE_MAX_BYTES
    env.baggageMaxItems = DD_TRACE_BAGGAGE_MAX_ITEMS
    env.baggageTagKeys = DD_TRACE_BAGGAGE_TAG_KEYS
    env.clientIpEnabled = isTrue(DD_TRACE_CLIENT_IP_ENABLED)
    env.clientIpHeader = DD_TRACE_CLIENT_IP_HEADER?.toLowerCase()
    env['crashtracking.enabled'] = isTrue(coalesce(
      DD_CRASHTRACKING_ENABLED,
      !this._isInServerlessEnvironment()
    ))
    env['codeOriginForSpans.enabled'] = isTrue(DD_CODE_ORIGIN_FOR_SPANS_ENABLED)
    env['codeOriginForSpans.experimental.exit_spans.enabled'] =
      isTrue(DD_CODE_ORIGIN_FOR_SPANS_EXPERIMENTAL_EXIT_SPANS_ENABLED)
    env.dbmPropagationMode = DD_DBM_PROPAGATION_MODE
    env['dogstatsd.hostname'] = DD_DOGSTATSD_HOST || DD_DOGSTATSD_HOSTNAME
    env['dogstatsd.port'] = DD_DOGSTATSD_PORT
    env.dsmEnabled = isTrue(DD_DATA_STREAMS_ENABLED)
    env['dynamicInstrumentation.enabled'] = isTrue(DD_DYNAMIC_INSTRUMENTATION_ENABLED)
    this._setArray(env, 'dynamicInstrumentation.redactedIdentifiers', DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS)
    this._setArray(
      env,
      'dynamicInstrumentation.redactionExcludedIdentifiers',
      DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS
    )
    env.env = DD_ENV || tags.env
    env.traceEnabled = isTrue(DD_TRACE_ENABLED)
    env['experimental.enableGetRumData'] = isTrue(DD_TRACE_EXPERIMENTAL_GET_RUM_DATA_ENABLED)
    env['experimental.exporter'] = DD_TRACE_EXPERIMENTAL_EXPORTER
    env['experimental.runtimeId'] = isTrue(DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED)
    if (AWS_LAMBDA_FUNCTION_NAME) {
      env.flushInterval = 0
    }
    env.flushMinSpans = maybeInt(DD_TRACE_PARTIAL_FLUSH_MIN_SPANS)
    this._envUnprocessed.flushMinSpans = DD_TRACE_PARTIAL_FLUSH_MIN_SPANS
    env.gitMetadataEnabled = isTrue(DD_TRACE_GIT_METADATA_ENABLED)
    this._setIntegerRangeSet(env, 'grpc.client.error.statuses', DD_GRPC_CLIENT_ERROR_STATUSES)
    this._setIntegerRangeSet(env, 'grpc.server.error.statuses', DD_GRPC_SERVER_ERROR_STATUSES)
    this._setArray(env, 'headerTags', DD_TRACE_HEADER_TAGS)
    env.hostname = coalesce(DD_AGENT_HOST, DD_TRACE_AGENT_HOSTNAME)
    env['iast.dbRowsToTaint'] = maybeInt(DD_IAST_DB_ROWS_TO_TAINT)
    env['iast.deduplicationEnabled'] = isTrue(DD_IAST_DEDUPLICATION_ENABLED)
    env['iast.enabled'] = isTrue(DD_IAST_ENABLED)
    env['iast.maxConcurrentRequests'] = maybeInt(DD_IAST_MAX_CONCURRENT_REQUESTS)
    this._envUnprocessed['iast.maxConcurrentRequests'] = DD_IAST_MAX_CONCURRENT_REQUESTS
    env['iast.maxContextOperations'] = maybeInt(DD_IAST_MAX_CONTEXT_OPERATIONS)
    this._envUnprocessed['iast.maxContextOperations'] = DD_IAST_MAX_CONTEXT_OPERATIONS
    env['iast.redactionEnabled'] = isTrue(DD_IAST_REDACTION_ENABLED && !isFalse(DD_IAST_REDACTION_ENABLED))
    env['iast.redactionNamePattern'] = DD_IAST_REDACTION_NAME_PATTERN
    env['iast.redactionValuePattern'] = DD_IAST_REDACTION_VALUE_PATTERN
    const iastRequestSampling = maybeInt(DD_IAST_REQUEST_SAMPLING)
    if (iastRequestSampling > -1 && iastRequestSampling < 101) {
      env['iast.requestSampling'] = iastRequestSampling
    }
    this._envUnprocessed['iast.requestSampling'] = DD_IAST_REQUEST_SAMPLING
    env['iast.securityControlsConfiguration'] = DD_IAST_SECURITY_CONTROLS_CONFIGURATION
    env['iast.telemetryVerbosity'] = DD_IAST_TELEMETRY_VERBOSITY
    env['iast.stackTrace.enabled'] = isTrue(DD_IAST_STACK_TRACE_ENABLED)
    this._setArray(env, 'injectionEnabled', DD_INJECTION_ENABLED)
    env.isAzureFunction = isTrue(getIsAzureFunction())
    env.isGCPFunction = isTrue(getIsGCPFunction())
    env['langchain.spanCharLimit'] = maybeInt(DD_LANGCHAIN_SPAN_CHAR_LIMIT)
    env['langchain.spanPromptCompletionSampleRate'] = maybeFloat(DD_LANGCHAIN_SPAN_PROMPT_COMPLETION_SAMPLE_RATE)
    env.legacyBaggageEnabled = isTrue(DD_TRACE_LEGACY_BAGGAGE_ENABLED)
    env['llmobs.agentlessEnabled'] = isTrue(DD_LLMOBS_AGENTLESS_ENABLED)
    env['llmobs.enabled'] = isTrue(DD_LLMOBS_ENABLED)
    env['llmobs.mlApp'] = DD_LLMOBS_ML_APP
    env.logInjection = isTrue(DD_LOGS_INJECTION)
    // Requires an accompanying DD_APM_OBFUSCATION_MEMCACHED_KEEP_COMMAND=true in the agent
    env.memcachedCommandEnabled = isTrue(DD_TRACE_MEMCACHED_COMMAND_ENABLED)
    env.middlewareTracingEnabled = isTrue(DD_TRACE_MIDDLEWARE_TRACING_ENABLED)
    env.openAiLogsEnabled = isTrue(DD_OPENAI_LOGS_ENABLED)
    env['openai.spanCharLimit'] = maybeInt(DD_OPENAI_SPAN_CHAR_LIMIT)
    this._envUnprocessed.openaiSpanCharLimit = DD_OPENAI_SPAN_CHAR_LIMIT
    if (DD_TRACE_PEER_SERVICE_MAPPING) {
      env.peerServiceMapping = Object.fromEntries(
        DD_TRACE_PEER_SERVICE_MAPPING.split(',').map(x => x.trim().split(':'))
      )
      this._envUnprocessed.peerServiceMapping = DD_TRACE_PEER_SERVICE_MAPPING
    }
    env.port = DD_TRACE_AGENT_PORT
    const profilingEnabled = normalizeProfilingEnabledValue(
      coalesce(
        DD_EXPERIMENTAL_PROFILING_ENABLED,
        DD_PROFILING_ENABLED,
        this._isInServerlessEnvironment() ? 'false' : undefined
      )
    )
    env['profiling.enabled'] = profilingEnabled
    env['profiling.exporters'] = DD_PROFILING_EXPORTERS
    env['profiling.sourceMap'] = isTrue(DD_PROFILING_SOURCE_MAP && !isFalse(DD_PROFILING_SOURCE_MAP))
    if (DD_INTERNAL_PROFILING_LONG_LIVED_THRESHOLD) {
      // This is only used in testing to not have to wait 30s
      env['profiling.longLivedThreshold'] = Number(DD_INTERNAL_PROFILING_LONG_LIVED_THRESHOLD)
    }

    env.protocolVersion = DD_TRACE_AGENT_PROTOCOL_VERSION
    env.queryStringObfuscation = DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP
    env['remoteConfig.enabled'] = isTrue(coalesce(
      DD_REMOTE_CONFIGURATION_ENABLED,
      !this._isInServerlessEnvironment()
    ))
    env['remoteConfig.pollInterval'] = maybeFloat(DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS)
    this._envUnprocessed['remoteConfig.pollInterval'] = DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS
    env.reportHostname = isTrue(DD_TRACE_REPORT_HOSTNAME)
    // only used to explicitly set runtimeMetrics to false
    const otelSetRuntimeMetrics = String(OTEL_METRICS_EXPORTER).toLowerCase() === 'none'
      ? false
      : undefined
    env.runtimeMetrics = isTrue(DD_RUNTIME_METRICS_ENABLED ||
    otelSetRuntimeMetrics)
    this._setArray(env, 'sampler.spanSamplingRules', reformatSpanSamplingRules(coalesce(
      safeJsonParse(maybeFile(DD_SPAN_SAMPLING_RULES_FILE)),
      safeJsonParse(DD_SPAN_SAMPLING_RULES)
    )))
    this._setUnit(env, 'sampleRate', DD_TRACE_SAMPLE_RATE ||
    getFromOtelSamplerMap(OTEL_TRACES_SAMPLER, OTEL_TRACES_SAMPLER_ARG))
    env['sampler.rateLimit'] = DD_TRACE_RATE_LIMIT
    this._setSamplingRule(env, 'sampler.rules', safeJsonParse(DD_TRACE_SAMPLING_RULES))
    this._envUnprocessed['sampler.rules'] = DD_TRACE_SAMPLING_RULES
    env.scope = DD_TRACE_SCOPE
    env.service = DD_SERVICE || DD_SERVICE_NAME || tags.service || OTEL_SERVICE_NAME
    if (DD_SERVICE_MAPPING) {
      env.serviceMapping = Object.fromEntries(
        process.env.DD_SERVICE_MAPPING.split(',').map(x => x.trim().split(':'))
      )
    }
    env.site = DD_SITE
    if (DD_TRACE_SPAN_ATTRIBUTE_SCHEMA) {
      env.spanAttributeSchema = validateNamingVersion(DD_TRACE_SPAN_ATTRIBUTE_SCHEMA)
      this._envUnprocessed.spanAttributeSchema = DD_TRACE_SPAN_ATTRIBUTE_SCHEMA
    }
    // 0: disabled, 1: logging, 2: garbage collection + logging
    env.spanLeakDebug = maybeInt(DD_TRACE_SPAN_LEAK_DEBUG)
    env.spanRemoveIntegrationFromService = isTrue(DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED)
    env.startupLogs = isTrue(DD_TRACE_STARTUP_LOGS)
    this._setTags(env, 'tags', tags)
    env.tagsHeaderMaxLength = DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH
    env['telemetry.enabled'] = isTrue(coalesce(
      DD_TRACE_TELEMETRY_ENABLED, // for backward compatibility
      DD_INSTRUMENTATION_TELEMETRY_ENABLED, // to comply with instrumentation telemetry specs
      !(this._isInServerlessEnvironment() || JEST_WORKER_ID)
    ))
    env.instrumentation_config_id = DD_INSTRUMENTATION_CONFIG_ID
    env['telemetry.debug'] = isTrue(DD_TELEMETRY_DEBUG)
    env['telemetry.dependencyCollection'] = isTrue(DD_TELEMETRY_DEPENDENCY_COLLECTION_ENABLED)
    env['telemetry.heartbeatInterval'] = maybeInt(Math.floor(DD_TELEMETRY_HEARTBEAT_INTERVAL * 1000))
    this._envUnprocessed['telemetry.heartbeatInterval'] = DD_TELEMETRY_HEARTBEAT_INTERVAL * 1000
    env['telemetry.logCollection'] = isTrue(DD_TELEMETRY_LOG_COLLECTION_ENABLED)
    env['telemetry.metrics'] = isTrue(DD_TELEMETRY_METRICS_ENABLED)
    env.traceId128BitGenerationEnabled = isTrue(DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED)
    env.traceId128BitLoggingEnabled = isTrue(DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED)
    env.tracePropagationExtractFirst = isTrue(DD_TRACE_PROPAGATION_EXTRACT_FIRST)
    const stringPropagationBehaviorExtract = String(DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT)
    env.tracePropagationBehaviorExtract =
      VALID_PROPAGATION_BEHAVIOR_EXTRACT.has(stringPropagationBehaviorExtract)
        ? stringPropagationBehaviorExtract
        : 'continue'
    env['tracePropagationStyle.otelPropagators'] = isTrue(
      DD_TRACE_PROPAGATION_STYLE ||
      DD_TRACE_PROPAGATION_STYLE_INJECT ||
      DD_TRACE_PROPAGATION_STYLE_EXTRACT
        ? false
        : !!OTEL_PROPAGATORS)
    env.tracing = isTrue(DD_TRACING_ENABLED)
    env.version = DD_VERSION || tags.version
    env.inferredProxyServicesEnabled = isTrue(DD_TRACE_INFERRED_PROXY_SERVICES_ENABLED)
    env['trace.aws.addSpanPointers'] = isTrue(DD_TRACE_AWS_ADD_SPAN_POINTERS)
    env['trace.dynamoDb.tablePrimaryKeys'] = DD_TRACE_DYNAMODB_TABLE_PRIMARY_KEYS
    this._setArray(env, 'graphqlErrorExtensions', DD_TRACE_GRAPHQL_ERROR_EXTENSIONS)
    env['trace.nativeSpanEvents'] = isTrue(DD_TRACE_NATIVE_SPAN_EVENTS)
    env['vertexai.spanPromptCompletionSampleRate'] = maybeFloat(DD_VERTEXAI_SPAN_PROMPT_COMPLETION_SAMPLE_RATE)
    env['vertexai.spanCharLimit'] = maybeInt(DD_VERTEXAI_SPAN_CHAR_LIMIT)
  }

  _applyOptions (options) {
    const opts = setHiddenProperty(this, '_options', this._options || {})
    const tags = {}
    setHiddenProperty(this, '_optsUnprocessed', {})

    options = setHiddenProperty(this, '_optionsArg', Object.assign({ ingestion: {} }, options, opts))

    tagger.add(tags, options.tags)

    opts.apmTracingEnabled = isTrue(coalesce(
      options.apmTracingEnabled,
      options.experimental?.appsec?.standalone && !options.experimental.appsec.standalone.enabled
    ))
    opts['appsec.apiSecurity.enabled'] = isTrue(options.appsec?.apiSecurity?.enabled)
    opts['appsec.blockedTemplateGraphql'] = maybeFile(options.appsec?.blockedTemplateGraphql)
    opts['appsec.blockedTemplateHtml'] = maybeFile(options.appsec?.blockedTemplateHtml)
    this._optsUnprocessed['appsec.blockedTemplateHtml'] = options.appsec?.blockedTemplateHtml
    opts['appsec.blockedTemplateJson'] = maybeFile(options.appsec?.blockedTemplateJson)
    this._optsUnprocessed['appsec.blockedTemplateJson'] = options.appsec?.blockedTemplateJson
    opts['appsec.enabled'] = isTrue(options.appsec?.enabled)
    opts['appsec.eventTracking.mode'] = options.appsec?.eventTracking?.mode
    opts['appsec.extendedHeadersCollection.enabled'] = isTrue(options.appsec?.extendedHeadersCollection?.enabled)
    opts['appsec.extendedHeadersCollection.redaction'] = isTrue(options.appsec?.extendedHeadersCollection?.redaction)
    opts['appsec.extendedHeadersCollection.maxHeaders'] =
      options.appsec?.extendedHeadersCollection?.maxHeaders
    opts['appsec.obfuscatorKeyRegex'] = options.appsec?.obfuscatorKeyRegex
    opts['appsec.obfuscatorValueRegex'] = options.appsec?.obfuscatorValueRegex
    opts['appsec.rasp.enabled'] = isTrue(options.appsec?.rasp?.enabled)
    opts['appsec.rasp.bodyCollection'] = isTrue(options.appsec?.rasp?.bodyCollection)
    opts['appsec.rateLimit'] = maybeInt(options.appsec?.rateLimit)
    this._optsUnprocessed['appsec.rateLimit'] = options.appsec?.rateLimit
    opts['appsec.rules'] = options.appsec?.rules
    opts['appsec.stackTrace.enabled'] = isTrue(options.appsec?.stackTrace?.enabled)
    opts['appsec.stackTrace.maxDepth'] = maybeInt(options.appsec?.stackTrace?.maxDepth)
    this._optsUnprocessed['appsec.stackTrace.maxDepth'] = options.appsec?.stackTrace?.maxDepth
    opts['appsec.stackTrace.maxStackTraces'] = maybeInt(options.appsec?.stackTrace?.maxStackTraces)
    this._optsUnprocessed['appsec.stackTrace.maxStackTraces'] = options.appsec?.stackTrace?.maxStackTraces
    opts['appsec.wafTimeout'] = maybeInt(options.appsec?.wafTimeout)
    this._optsUnprocessed['appsec.wafTimeout'] = options.appsec?.wafTimeout
    opts.clientIpEnabled = isTrue(options.clientIpEnabled)
    opts.clientIpHeader = options.clientIpHeader?.toLowerCase()
    opts.baggageMaxBytes = options.baggageMaxBytes
    opts.baggageMaxItems = options.baggageMaxItems
    opts.baggageTagKeys = options.baggageTagKeys
    opts['codeOriginForSpans.enabled'] = isTrue(options.codeOriginForSpans?.enabled)
    opts['codeOriginForSpans.experimental.exit_spans.enabled'] =
      isTrue(options.codeOriginForSpans?.experimental?.exit_spans?.enabled)
    opts.dbmPropagationMode = options.dbmPropagationMode
    if (options.dogstatsd) {
      opts['dogstatsd.hostname'] = options.dogstatsd.hostname
      opts['dogstatsd.port'] = options.dogstatsd.port
    }
    opts.dsmEnabled = isTrue(options.dsmEnabled)
    opts['dynamicInstrumentation.enabled'] = isTrue(options.dynamicInstrumentation?.enabled)
    this._setArray(
      opts,
      'dynamicInstrumentation.redactedIdentifiers',
      options.dynamicInstrumentation?.redactedIdentifiers
    )
    this._setArray(
      opts,
      'dynamicInstrumentation.redactionExcludedIdentifiers',
      options.dynamicInstrumentation?.redactionExcludedIdentifiers
    )
    opts.env = options.env || tags.env
    opts['experimental.enableGetRumData'] = isTrue(options.experimental?.enableGetRumData)
    opts['experimental.exporter'] = options.experimental?.exporter
    opts['experimental.runtimeId'] = isTrue(options.experimental?.runtimeId)
    opts.flushInterval = maybeInt(options.flushInterval)
    this._optsUnprocessed.flushInterval = options.flushInterval
    opts.flushMinSpans = maybeInt(options.flushMinSpans)
    this._optsUnprocessed.flushMinSpans = options.flushMinSpans
    this._setArray(opts, 'headerTags', options.headerTags)
    opts.hostname = options.hostname
    opts['iast.dbRowsToTaint'] = maybeInt(options.iast?.dbRowsToTaint)
    opts['iast.deduplicationEnabled'] = isTrue(options.iast && options.iast.deduplicationEnabled)
    opts['iast.enabled'] = isTrue(options.iast && (options.iast === true || options.iast.enabled === true))
    opts['iast.maxConcurrentRequests'] =
      maybeInt(options.iast?.maxConcurrentRequests)
    this._optsUnprocessed['iast.maxConcurrentRequests'] = options.iast?.maxConcurrentRequests
    opts['iast.maxContextOperations'] = maybeInt(options.iast?.maxContextOperations)
    this._optsUnprocessed['iast.maxContextOperations'] = options.iast?.maxContextOperations
    opts['iast.redactionEnabled'] = isTrue(options.iast?.redactionEnabled)
    opts['iast.redactionNamePattern'] = options.iast?.redactionNamePattern
    opts['iast.redactionValuePattern'] = options.iast?.redactionValuePattern
    const iastRequestSampling = maybeInt(options.iast?.requestSampling)
    if (iastRequestSampling > -1 && iastRequestSampling < 101) {
      opts['iast.requestSampling'] = iastRequestSampling
      this._optsUnprocessed['iast.requestSampling'] = options.iast?.requestSampling
    }
    opts['iast.securityControlsConfiguration'] = options.iast?.securityControlsConfiguration
    opts['iast.stackTrace.enabled'] = isTrue(options.iast?.stackTrace?.enabled)
    opts['iast.telemetryVerbosity'] = options.iast && options.iast.telemetryVerbosity
    opts.isCiVisibility = isTrue(options.isCiVisibility)
    opts.legacyBaggageEnabled = isTrue(options.legacyBaggageEnabled)
    opts['llmobs.agentlessEnabled'] = isTrue(options.llmobs?.agentlessEnabled)
    opts['llmobs.mlApp'] = options.llmobs?.mlApp
    opts.logInjection = isTrue(options.logInjection)
    opts.lookup = options.lookup
    opts.middlewareTracingEnabled = isTrue(options.middlewareTracingEnabled)
    opts.openAiLogsEnabled = isTrue(options.openAiLogsEnabled)
    opts.peerServiceMapping = options.peerServiceMapping
    opts.plugins = isTrue(options.plugins)
    opts.port = options.port
    const strProfiling = String(options.profiling)
    if (['true', 'false', 'auto'].includes(strProfiling)) {
      opts['profiling.enabled'] = strProfiling
    }
    opts.protocolVersion = options.protocolVersion
    if (options.remoteConfig) {
      opts['remoteConfig.pollInterval'] = maybeFloat(options.remoteConfig.pollInterval)
      this._optsUnprocessed['remoteConfig.pollInterval'] = options.remoteConfig.pollInterval
    }
    opts.reportHostname = isTrue(options.reportHostname)
    opts.runtimeMetrics = isTrue(options.runtimeMetrics)
    this._setArray(opts, 'sampler.spanSamplingRules', reformatSpanSamplingRules(options.spanSamplingRules))
    this._setUnit(opts, 'sampleRate', coalesce(options.sampleRate, options.ingestion.sampleRate))
    const ingestion = options.ingestion || {}
    opts['sampler.rateLimit'] = coalesce(options.rateLimit, ingestion.rateLimit)
    this._setSamplingRule(opts, 'sampler.rules', options.samplingRules)
    opts.service = options.service || tags.service
    opts.serviceMapping = options.serviceMapping
    opts.site = options.site
    if (options.spanAttributeSchema) {
      opts.spanAttributeSchema = validateNamingVersion(options.spanAttributeSchema)
      this._optsUnprocessed.spanAttributeSchema = options.spanAttributeSchema
    }
    opts.spanRemoveIntegrationFromService = isTrue(options.spanRemoveIntegrationFromService)
    opts.startupLogs = isTrue(options.startupLogs)
    this._setTags(opts, 'tags', tags)
    opts.traceId128BitGenerationEnabled = isTrue(options.traceId128BitGenerationEnabled)
    opts.traceId128BitLoggingEnabled = isTrue(options.traceId128BitLoggingEnabled)
    opts.version = options.version || tags.version
    opts.inferredProxyServicesEnabled = isTrue(options.inferredProxyServicesEnabled)
    opts.graphqlErrorExtensions = isTrue(options.graphqlErrorExtensions)
    opts['trace.nativeSpanEvents'] = isTrue(options.trace?.nativeSpanEvents)

    // For LLMObs, we want the environment variable to take precedence over the options.
    // This is reliant on environment config being set before options.
    // This is to make sure the origins of each value are tracked appropriately for telemetry.
    // We'll only set `llmobs.enabled` on the opts when it's not set on the environment, and options.llmobs is provided.
    const llmobsEnabledEnv = this._env['llmobs.enabled']
    if (llmobsEnabledEnv == null && options.llmobs) {
      opts['llmobs.enabled'] = !!options.llmobs
    }
  }

  _isCiVisibility () {
    return coalesce(
      this._optionsArg.isCiVisibility,
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
      : getAgentUrl(this._getTraceAgentUrl(), this._optionsArg)
    const DD_AGENT_HOST = coalesce(
      this._optionsArg.hostname,
      process.env.DD_AGENT_HOST,
      process.env.DD_TRACE_AGENT_HOSTNAME,
      '127.0.0.1'
    )
    return DD_AGENT_HOST || (url && url.hostname)
  }

  _getSpanComputePeerService () {
    const DD_TRACE_SPAN_ATTRIBUTE_SCHEMA = validateNamingVersion(
      coalesce(
        this._optionsArg.spanAttributeSchema,
        process.env.DD_TRACE_SPAN_ATTRIBUTE_SCHEMA
      )
    )

    const peerServiceSet = (
      this._optionsArg.hasOwnProperty('spanComputePeerService') ||
      process.env.hasOwnProperty('DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED')
    )
    const peerServiceValue = coalesce(
      this._optionsArg.spanComputePeerService,
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
    return coalesce(
      process.env.DD_CIVISIBILITY_MANUAL_API_ENABLED,
      true
    )
  }

  _isTraceStatsComputationEnabled () {
    const apmTracingEnabled = this._options.apmTracingEnabled !== false &&
      this._env.apmTracingEnabled !== false

    return apmTracingEnabled && coalesce(
      this._optionsArg.stats,
      process.env.DD_TRACE_STATS_COMPUTATION_ENABLED,
      getIsGCPFunction() || getIsAzureFunction()
    )
  }

  _getTraceAgentUrl () {
    return coalesce(
      this._optionsArg.url,
      process.env.DD_TRACE_AGENT_URL,
      process.env.DD_TRACE_URL,
      null
    )
  }

  // handles values calculated from a mixture of options and env vars
  _applyCalculated () {
    const calc = setHiddenProperty(this, '_calculated', {})

    const {
      DD_CIVISIBILITY_AGENTLESS_URL,
      DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED,
      DD_CIVISIBILITY_FLAKY_RETRY_ENABLED,
      DD_CIVISIBILITY_FLAKY_RETRY_COUNT,
      DD_TEST_SESSION_NAME,
      DD_AGENTLESS_LOG_SUBMISSION_ENABLED,
      DD_TEST_FAILED_TEST_REPLAY_ENABLED,
      DD_TEST_MANAGEMENT_ENABLED,
      DD_TEST_MANAGEMENT_ATTEMPT_TO_FIX_RETRIES
    } = process.env

    calc.url = DD_CIVISIBILITY_AGENTLESS_URL
      ? new URL(DD_CIVISIBILITY_AGENTLESS_URL)
      : getAgentUrl(this._getTraceAgentUrl(), this._optionsArg)

    if (this._isCiVisibility()) {
      calc.isEarlyFlakeDetectionEnabled = isTrue(coalesce(DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED, true))
      calc.isFlakyTestRetriesEnabled = isTrue(coalesce(DD_CIVISIBILITY_FLAKY_RETRY_ENABLED, true))
      calc.flakyTestRetriesCount = coalesce(maybeInt(DD_CIVISIBILITY_FLAKY_RETRY_COUNT), 5)
      calc.isIntelligentTestRunnerEnabled = isTrue(this._isCiVisibilityItrEnabled())
      calc.isManualApiEnabled = !isFalse(this._isCiVisibilityManualApiEnabled())
      calc.ciVisibilityTestSessionName = DD_TEST_SESSION_NAME
      calc.ciVisAgentlessLogSubmissionEnabled = isTrue(DD_AGENTLESS_LOG_SUBMISSION_ENABLED)
      calc.isTestDynamicInstrumentationEnabled = !isFalse(DD_TEST_FAILED_TEST_REPLAY_ENABLED)
      calc.isServiceUserProvided = !!this._env.service
      calc.isTestManagementEnabled = !isFalse(DD_TEST_MANAGEMENT_ENABLED)
      calc.testManagementAttemptToFixRetries =
        coalesce(maybeInt(DD_TEST_MANAGEMENT_ATTEMPT_TO_FIX_RETRIES), 20)
    }
    calc['dogstatsd.hostname'] = this._getHostname()
    calc.isGitUploadEnabled = isTrue(
      calc.isIntelligentTestRunnerEnabled && !isFalse(this._isCiVisibilityGitUploadEnabled()))
    calc.spanComputePeerService = isTrue(this._getSpanComputePeerService())
    calc['stats.enabled'] = isTrue(this._isTraceStatsComputationEnabled())
    const defaultPropagationStyle = this._getDefaultPropagationStyle(this._optionsArg)
    calc['tracePropagationStyle.inject'] = propagationStyle(
      'inject',
      this._optionsArg.tracePropagationStyle
    )
    calc['tracePropagationStyle.extract'] = propagationStyle(
      'extract',
      this._optionsArg.tracePropagationStyle
    )
    if (defaultPropagationStyle.length > 2) {
      calc['tracePropagationStyle.inject'] ||= defaultPropagationStyle
      calc['tracePropagationStyle.extract'] ||= defaultPropagationStyle
    }
  }

  _applyRemote (options) {
    const opts = setHiddenProperty(this, '_remote', this._remote || {})
    setHiddenProperty(this, '_remoteUnprocessed', {})
    const tags = {}
    const headerTags = options.tracing_header_tags
      ? options.tracing_header_tags.map(tag => {
        return tag.tag_name ? `${tag.header}:${tag.tag_name}` : tag.header
      })
      : undefined

    tagger.add(tags, options.tracing_tags)
    if (Object.keys(tags).length) tags['runtime-id'] = runtimeId

    this._setUnit(opts, 'sampleRate', options.tracing_sampling_rate)
    opts.logInjection = isTrue(options.log_injection_enabled)
    this._setArray(opts, 'headerTags', headerTags)
    this._setTags(opts, 'tags', tags)
    opts.tracing = isTrue(options.tracing_enabled)
    this._remoteUnprocessed['sampler.rules'] = options.tracing_sampling_rules
    this._setSamplingRule(opts, 'sampler.rules', this._reformatTags(options.tracing_sampling_rules))
  }

  _reformatTags (samplingRules) {
    for (const rule of (samplingRules || [])) {
      const reformattedTags = {}
      if (rule.tags) {
        for (const tag of (rule.tags || {})) {
          reformattedTags[tag.key] = tag.value_glob
        }
        rule.tags = reformattedTags
      }
    }
    return samplingRules
  }

  _setUnit (obj, name, value) {
    if (value === null || value === undefined) {
      obj[name] = value
      return
    }
    value = Number.parseFloat(value)
    if (!Number.isNaN(value)) {
      obj[name] = Math.min(Math.max(value, 0), 1)
    }
  }

  _setArray (obj, name, value) {
    if (value == null) {
      obj[name] = null
      return
    }
    if (typeof value === 'string') {
      value = value.split(',').map(item => {
        const [key, val] = item.split(':').map(part => part.trim())
        return val === undefined ? key : `${key}:${val}`
      })
    }
    if (Array.isArray(value)) {
      obj[name] = value
    }
  }

  _setIntegerRangeSet (obj, name, value) {
    if (value == null) {
      obj[name] = null
      return
    }
    value = value.split(',')
    const result = []
    value.forEach(val => {
      if (val.includes('-')) {
        const [start, end] = val.split('-').map(Number)
        for (let i = start; i <= end; i++) {
          result.push(i)
        }
      } else {
        result.push(Number(val))
      }
    })
    obj[name] = result
  }

  _setSamplingRule (obj, name, value) {
    if (value == null) {
      obj[name] = null
      return
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
      obj[name] = value
    }
  }

  _setTags (obj, name, value) {
    if (!value || Object.keys(value).length === 0) {
      obj[name] = null
      return
    }
    obj[name] = value
  }

  // TODO: Report origin changes and errors to telemetry.
  // TODO: Deeply merge configurations.
  // TODO: Move change tracking to telemetry.
  // for telemetry reporting, `name`s in `containers` need to be keys from:
  // https://github.com/DataDog/dd-go/blob/prod/trace/apps/tracer-telemetry-intake/telemetry-payload/static/config_norm_rules.json
  _merge () {
    const containers = [
      this._remote,
      this._options,
      this._fleetStableConfig,
      this._env,
      this._localStableConfig,
      this._calculated,
      this._defaults
    ]
    const origins = [
      'remote_config',
      'code',
      'fleet_stable_config',
      'env_var',
      'local_stable_config',
      'calculated',
      'default'
    ]
    const unprocessedValues = [
      this._remoteUnprocessed,
      this._optsUnprocessed,
      {},
      this._envUnprocessed,
      {},
      {},
      {}
    ]
    const changes = []

    for (const name in this._defaults) {
      for (let i = 0; i < containers.length; i++) {
        const container = containers[i]
        const value = container[name]

        if ((value !== null && value !== undefined) || container === this._defaults) {
          if (get(this, name) === value && has(this, name)) break

          set(this, name, value)

          changes.push({
            name,
            value: unprocessedValues[i][name] || value,
            origin: origins[i]
          })

          break
        }
      }
    }

    this.sampler.sampleRate = this.sampleRate
    updateConfig(changes, this)
  }

  // TODO: Refactor the Config class so it never produces any config objects that are incompatible with MessageChannel
  /**
   * Serializes the config object so it can be passed over a Worker Thread MessageChannel.
   * @returns {Object} The serialized config object.
   */
  serialize () {
    // URL objects cannot be serialized over the MessageChannel, so we need to convert them to strings first
    if (this.url instanceof URL) {
      const config = { ...this }
      config.url = this.url.toString()
      return config
    }

    return this
  }
}

function handleOtel (tagString) {
  return tagString
    ?.replace(/(^|,)deployment\.environment=/, '$1env:')
    .replace(/(^|,)service\.name=/, '$1service:')
    .replace(/(^|,)service\.version=/, '$1version:')
    .replace(/=/g, ':')
}

function parseSpaceSeparatedTags (tagString) {
  if (tagString && !tagString.includes(',')) {
    tagString = tagString.replace(/\s+/g, ',')
  }
  return tagString
}

function maybeInt (number) {
  const parsed = Number.parseInt(number)
  return Number.isNaN(parsed) ? undefined : parsed
}

function maybeFloat (number) {
  const parsed = Number.parseFloat(number)
  return Number.isNaN(parsed) ? undefined : parsed
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

function setHiddenProperty (obj, name, value) {
  Object.defineProperty(obj, name, {
    value,
    enumerable: false,
    writable: true
  })
  return obj[name]
}

module.exports = Config
