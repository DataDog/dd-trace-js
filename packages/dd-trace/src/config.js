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
const { getEnvironmentVariable, getEnvironmentVariables } = require('./config-helper')

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
  if (!getEnvironmentVariable('PROPAGATION_STYLE_EXTRACT') &&
    !getEnvironmentVariable('PROPAGATION_STYLE_INJECT') &&
    !getEnvironmentVariable('DD_TRACE_PROPAGATION_STYLE') &&
    getEnvironmentVariable('OTEL_PROPAGATORS')) {
    for (const style in propagators) {
      if (!VALID_PROPAGATION_STYLES.has(style)) {
        log.warn('unexpected value for OTEL_PROPAGATORS environment variable')
        getCounter('otel.env.invalid', 'DD_TRACE_PROPAGATION_STYLE', 'OTEL_PROPAGATORS').inc()
      }
    }
  }
}

function validateEnvVarType (envVar) {
  const value = getEnvironmentVariable(envVar)
  switch (envVar) {
    case 'OTEL_LOG_LEVEL':
      return VALID_LOG_LEVELS.has(value)
    case 'OTEL_PROPAGATORS':
    case 'OTEL_RESOURCE_ATTRIBUTES':
    case 'OTEL_SERVICE_NAME':
      return typeof value === 'string'
    case 'OTEL_TRACES_SAMPLER':
      return getFromOtelSamplerMap(value, getEnvironmentVariable('OTEL_TRACES_SAMPLER_ARG')) !== undefined
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
    if (ddEnvVar && getEnvironmentVariable(ddEnvVar) && getEnvironmentVariable(otelEnvVar)) {
      log.warn(`both ${ddEnvVar} and ${otelEnvVar} environment variables are set`)
      getCounter('otel.env.hiding', ddEnvVar, otelEnvVar).inc()
    }

    if (getEnvironmentVariable(otelEnvVar) && !validateEnvVarType(otelEnvVar)) {
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

  const envVar = coalesce(getEnvironmentVariable(envKey),
    getEnvironmentVariable('DD_TRACE_PROPAGATION_STYLE'), getEnvironmentVariable('OTEL_PROPAGATORS'))
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

    const DD_API_KEY = getEnvironmentVariable('DD_API_KEY')

    if (getEnvironmentVariable('DD_TRACE_PROPAGATION_STYLE') && (
      getEnvironmentVariable('DD_TRACE_PROPAGATION_STYLE_INJECT') ||
      getEnvironmentVariable('DD_TRACE_PROPAGATION_STYLE_EXTRACT')
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
      getEnvironmentVariable('DD_INSTRUMENTATION_INSTALL_ID'),
      null
    )
    const DD_INSTRUMENTATION_INSTALL_TIME = coalesce(
      getEnvironmentVariable('DD_INSTRUMENTATION_INSTALL_TIME'),
      null
    )
    const DD_INSTRUMENTATION_INSTALL_TYPE = coalesce(
      getEnvironmentVariable('DD_INSTRUMENTATION_INSTALL_TYPE'),
      null
    )

    const DD_TRACE_CLOUD_REQUEST_PAYLOAD_TAGGING = splitJSONPathRules(
      coalesce(
        getEnvironmentVariable('DD_TRACE_CLOUD_REQUEST_PAYLOAD_TAGGING'),
        options.cloudPayloadTagging?.request,
        ''
      ))

    const DD_TRACE_CLOUD_RESPONSE_PAYLOAD_TAGGING = splitJSONPathRules(
      coalesce(
        getEnvironmentVariable('DD_TRACE_CLOUD_RESPONSE_PAYLOAD_TAGGING'),
        options.cloudPayloadTagging?.response,
        ''
      ))

    const DD_TRACE_CLOUD_PAYLOAD_TAGGING_MAX_DEPTH = coalesce(
      getEnvironmentVariable('DD_TRACE_CLOUD_PAYLOAD_TAGGING_MAX_DEPTH'),
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
          getEnvironmentVariable('DD_GIT_REPOSITORY_URL'),
          this.tags[GIT_REPOSITORY_URL]
        )
      )
      this.commitSHA = coalesce(
        getEnvironmentVariable('DD_GIT_COMMIT_SHA'),
        this.tags[GIT_COMMIT_SHA]
      )
      if (!this.repositoryUrl || !this.commitSHA) {
        const DD_GIT_PROPERTIES_FILE = coalesce(
          getEnvironmentVariable('DD_GIT_PROPERTIES_FILE'),
          `${process.cwd()}/git.properties`
        )
        let gitPropertiesString
        try {
          gitPropertiesString = fs.readFileSync(DD_GIT_PROPERTIES_FILE, 'utf8')
        } catch (e) {
          // Only log error if the user has set a git.properties path
          if (getEnvironmentVariable('DD_GIT_PROPERTIES_FILE')) {
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
      getEnvironmentVariable('DD_TRACE_EXPERIMENTAL_B3_ENABLED'),
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
    } = getEnvironmentVariables()

    const service = AWS_LAMBDA_FUNCTION_NAME ||
      FUNCTION_NAME || // Google Cloud Function Name set by deprecated runtimes
      K_SERVICE || // Google Cloud Function Name set by newer runtimes
      WEBSITE_SITE_NAME || // set by Azure Functions
      pkg.name ||
      'node'

    const defaults = setHiddenProperty(this, '_defaults', {})

    this._setBoolean(defaults, 'apmTracingEnabled', true)
    this._setValue(defaults, 'appsec.apiSecurity.enabled', true)
    this._setValue(defaults, 'appsec.apiSecurity.sampleDelay', 30)
    this._setValue(defaults, 'appsec.blockedTemplateGraphql')
    this._setValue(defaults, 'appsec.blockedTemplateHtml')
    this._setValue(defaults, 'appsec.blockedTemplateJson')
    this._setValue(defaults, 'appsec.enabled')
    this._setValue(defaults, 'appsec.eventTracking.mode', 'identification')
    this._setValue(defaults, 'appsec.extendedHeadersCollection.enabled', false)
    this._setValue(defaults, 'appsec.extendedHeadersCollection.redaction', true)
    this._setValue(defaults, 'appsec.extendedHeadersCollection.maxHeaders', 50)
    this._setValue(defaults, 'appsec.obfuscatorKeyRegex', defaultWafObfuscatorKeyRegex)
    this._setValue(defaults, 'appsec.obfuscatorValueRegex', defaultWafObfuscatorValueRegex)
    this._setValue(defaults, 'appsec.rasp.enabled', true)
    this._setValue(defaults, 'appsec.rasp.bodyCollection', false)
    this._setValue(defaults, 'appsec.rateLimit', 100)
    this._setValue(defaults, 'appsec.rules')
    this._setValue(defaults, 'appsec.sca.enabled', null)
    this._setValue(defaults, 'appsec.stackTrace.enabled', true)
    this._setValue(defaults, 'appsec.stackTrace.maxDepth', 32)
    this._setValue(defaults, 'appsec.stackTrace.maxStackTraces', 2)
    this._setValue(defaults, 'appsec.wafTimeout', 5e3) // µs
    this._setValue(defaults, 'baggageMaxBytes', 8192)
    this._setValue(defaults, 'baggageMaxItems', 64)
    this._setValue(defaults, 'baggageTagKeys', 'user.id,session.id,account.id')
    this._setValue(defaults, 'ciVisibilityTestSessionName', '')
    this._setValue(defaults, 'clientIpEnabled', false)
    this._setValue(defaults, 'clientIpHeader', null)
    this._setValue(defaults, 'crashtracking.enabled', true)
    this._setValue(defaults, 'codeOriginForSpans.enabled', true)
    this._setValue(defaults, 'codeOriginForSpans.experimental.exit_spans.enabled', false)
    this._setValue(defaults, 'dbmPropagationMode', 'disabled')
    this._setValue(defaults, 'dogstatsd.hostname', '127.0.0.1')
    this._setValue(defaults, 'dogstatsd.port', '8125')
    this._setValue(defaults, 'dsmEnabled', false)
    this._setValue(defaults, 'dynamicInstrumentation.enabled', false)
    this._setValue(defaults, 'dynamicInstrumentation.redactedIdentifiers', [])
    this._setValue(defaults, 'dynamicInstrumentation.redactionExcludedIdentifiers', [])
    this._setValue(defaults, 'env')
    this._setValue(defaults, 'experimental.enableGetRumData', false)
    this._setValue(defaults, 'experimental.exporter')
    this._setValue(defaults, 'experimental.runtimeId', false)
    this._setValue(defaults, 'flushInterval', 2000)
    this._setValue(defaults, 'flushMinSpans', 1000)
    this._setValue(defaults, 'gitMetadataEnabled', true)
    this._setValue(defaults, 'graphqlErrorExtensions', [])
    this._setValue(defaults, 'grpc.client.error.statuses', GRPC_CLIENT_ERROR_STATUSES)
    this._setValue(defaults, 'grpc.server.error.statuses', GRPC_SERVER_ERROR_STATUSES)
    this._setValue(defaults, 'headerTags', [])
    this._setValue(defaults, 'hostname', '127.0.0.1')
    this._setValue(defaults, 'iast.dbRowsToTaint', 1)
    this._setValue(defaults, 'iast.deduplicationEnabled', true)
    this._setValue(defaults, 'iast.enabled', false)
    this._setValue(defaults, 'iast.maxConcurrentRequests', 2)
    this._setValue(defaults, 'iast.maxContextOperations', 2)
    this._setValue(defaults, 'iast.redactionEnabled', true)
    this._setValue(defaults, 'iast.redactionNamePattern', null)
    this._setValue(defaults, 'iast.redactionValuePattern', null)
    this._setValue(defaults, 'iast.requestSampling', 30)
    this._setValue(defaults, 'iast.securityControlsConfiguration', null)
    this._setValue(defaults, 'iast.telemetryVerbosity', 'INFORMATION')
    this._setValue(defaults, 'iast.stackTrace.enabled', true)
    this._setValue(defaults, 'injectionEnabled', [])
    this._setValue(defaults, 'isAzureFunction', false)
    this._setValue(defaults, 'isCiVisibility', false)
    this._setValue(defaults, 'isEarlyFlakeDetectionEnabled', false)
    this._setValue(defaults, 'isFlakyTestRetriesEnabled', false)
    this._setValue(defaults, 'flakyTestRetriesCount', 5)
    this._setValue(defaults, 'isGCPFunction', false)
    this._setValue(defaults, 'isGitUploadEnabled', false)
    this._setValue(defaults, 'isIntelligentTestRunnerEnabled', false)
    this._setValue(defaults, 'isManualApiEnabled', false)
    this._setValue(defaults, 'langchain.spanCharLimit', 128)
    this._setValue(defaults, 'langchain.spanPromptCompletionSampleRate', 1)
    this._setValue(defaults, 'llmobs.agentlessEnabled')
    this._setValue(defaults, 'llmobs.enabled', false)
    this._setValue(defaults, 'llmobs.mlApp')
    this._setValue(defaults, 'ciVisibilityTestSessionName', '')
    this._setValue(defaults, 'ciVisAgentlessLogSubmissionEnabled', false)
    this._setValue(defaults, 'legacyBaggageEnabled', true)
    this._setValue(defaults, 'isTestDynamicInstrumentationEnabled', false)
    this._setValue(defaults, 'isServiceUserProvided', false)
    this._setValue(defaults, 'testManagementAttemptToFixRetries', 20)
    this._setValue(defaults, 'isTestManagementEnabled', false)
    this._setValue(defaults, 'isImpactedTestsEnabled', false)
    this._setValue(defaults, 'logInjection', false)
    this._setValue(defaults, 'lookup')
    this._setValue(defaults, 'inferredProxyServicesEnabled', false)
    this._setValue(defaults, 'memcachedCommandEnabled', false)
    this._setValue(defaults, 'middlewareTracingEnabled', true)
    this._setValue(defaults, 'openAiLogsEnabled', false)
    this._setValue(defaults, 'openai.spanCharLimit', 128)
    this._setValue(defaults, 'peerServiceMapping', {})
    this._setValue(defaults, 'plugins', true)
    this._setValue(defaults, 'port', '8126')
    this._setValue(defaults, 'profiling.enabled')
    this._setValue(defaults, 'profiling.exporters', 'agent')
    this._setValue(defaults, 'profiling.sourceMap', true)
    this._setValue(defaults, 'profiling.longLivedThreshold')
    this._setValue(defaults, 'protocolVersion', '0.4')
    this._setValue(defaults, 'queryStringObfuscation', qsRegex)
    this._setValue(defaults, 'remoteConfig.enabled', true)
    this._setValue(defaults, 'remoteConfig.pollInterval', 5) // seconds
    this._setValue(defaults, 'reportHostname', false)
    this._setValue(defaults, 'runtimeMetrics', false)
    this._setValue(defaults, 'sampleRate')
    this._setValue(defaults, 'sampler.rateLimit', 100)
    this._setValue(defaults, 'sampler.rules', [])
    this._setValue(defaults, 'sampler.spanSamplingRules', [])
    this._setValue(defaults, 'scope')
    this._setValue(defaults, 'service', service)
    this._setValue(defaults, 'serviceMapping', {})
    this._setValue(defaults, 'site', 'datadoghq.com')
    this._setValue(defaults, 'spanAttributeSchema', 'v0')
    this._setValue(defaults, 'spanComputePeerService', false)
    this._setValue(defaults, 'spanLeakDebug', 0)
    this._setValue(defaults, 'spanRemoveIntegrationFromService', false)
    this._setValue(defaults, 'startupLogs', false)
    this._setValue(defaults, 'stats.enabled', false)
    this._setValue(defaults, 'tags', {})
    this._setValue(defaults, 'tagsHeaderMaxLength', 512)
    this._setValue(defaults, 'telemetry.debug', false)
    this._setValue(defaults, 'telemetry.dependencyCollection', true)
    this._setValue(defaults, 'telemetry.enabled', true)
    this._setValue(defaults, 'telemetry.heartbeatInterval', 60_000)
    this._setValue(defaults, 'telemetry.logCollection', true)
    this._setValue(defaults, 'telemetry.metrics', true)
    this._setValue(defaults, 'traceEnabled', true)
    this._setValue(defaults, 'traceId128BitGenerationEnabled', true)
    this._setValue(defaults, 'traceId128BitLoggingEnabled', true)
    this._setValue(defaults, 'tracePropagationExtractFirst', false)
    this._setValue(defaults, 'tracePropagationBehaviorExtract', 'continue')
    this._setValue(defaults, 'tracePropagationStyle.inject', ['datadog', 'tracecontext', 'baggage'])
    this._setValue(defaults, 'tracePropagationStyle.extract', ['datadog', 'tracecontext', 'baggage'])
    this._setValue(defaults, 'tracePropagationStyle.otelPropagators', false)
    this._setValue(defaults, 'tracing', true)
    this._setValue(defaults, 'url')
    this._setValue(defaults, 'version', pkg.version)
    this._setValue(defaults, 'instrumentation_config_id')
    this._setValue(defaults, 'vertexai.spanCharLimit', 128)
    this._setValue(defaults, 'vertexai.spanPromptCompletionSampleRate', 1)
    this._setValue(defaults, 'trace.aws.addSpanPointers', true)
    this._setValue(defaults, 'trace.dynamoDb.tablePrimaryKeys')
    this._setValue(defaults, 'trace.nativeSpanEvents', false)
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

    this._setBoolean(obj, 'appsec.enabled', DD_APPSEC_ENABLED)
    this._setBoolean(obj, 'appsec.sca.enabled', DD_APPSEC_SCA_ENABLED)
    this._setBoolean(obj, 'dsmEnabled', DD_DATA_STREAMS_ENABLED)
    this._setBoolean(obj, 'dynamicInstrumentation.enabled', DD_DYNAMIC_INSTRUMENTATION_ENABLED)
    this._setString(obj, 'env', DD_ENV)
    this._setBoolean(obj, 'iast.enabled', DD_IAST_ENABLED)
    this._setBoolean(obj, 'logInjection', DD_LOGS_INJECTION)
    const profilingEnabled = normalizeProfilingEnabledValue(DD_PROFILING_ENABLED)
    this._setString(obj, 'profiling.enabled', profilingEnabled)
    this._setBoolean(obj, 'runtimeMetrics', DD_RUNTIME_METRICS_ENABLED)
    this._setString(obj, 'service', DD_SERVICE)
    this._setString(obj, 'version', DD_VERSION)
  }

  _applyEnvironment () {
    const {
      AWS_LAMBDA_FUNCTION_NAME,
      DD_AGENT_HOST,
      DD_API_SECURITY_ENABLED,
      DD_API_SECURITY_SAMPLE_DELAY,
      DD_APM_TRACING_ENABLED,
      DD_APPSEC_AUTO_USER_INSTRUMENTATION_MODE,
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
      DD_DOGSTATSD_HOST,
      DD_DOGSTATSD_PORT,
      DD_DYNAMIC_INSTRUMENTATION_ENABLED,
      DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS,
      DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS,
      DD_ENV,
      DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED,
      DD_PROFILING_ENABLED,
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
      DD_PROFILING_EXPORTERS,
      DD_PROFILING_SOURCE_MAP,
      DD_INTERNAL_PROFILING_LONG_LIVED_THRESHOLD,
      DD_REMOTE_CONFIGURATION_ENABLED,
      DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS,
      DD_RUNTIME_METRICS_ENABLED,
      DD_SERVICE,
      DD_SERVICE_MAPPING,
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
    } = getEnvironmentVariables()

    const tags = {}
    const env = setHiddenProperty(this, '_env', {})
    setHiddenProperty(this, '_envUnprocessed', {})

    tagger.add(tags, parseSpaceSeparatedTags(handleOtel(OTEL_RESOURCE_ATTRIBUTES)))
    tagger.add(tags, parseSpaceSeparatedTags(DD_TAGS))
    tagger.add(tags, DD_TRACE_TAGS)
    tagger.add(tags, DD_TRACE_GLOBAL_TAGS)

    this._setBoolean(env, 'apmTracingEnabled', coalesce(
      DD_APM_TRACING_ENABLED,
      DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED && isFalse(DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED)
    ))
    this._setBoolean(env, 'appsec.apiSecurity.enabled', DD_API_SECURITY_ENABLED && isTrue(DD_API_SECURITY_ENABLED))
    this._setValue(env, 'appsec.apiSecurity.sampleDelay', maybeFloat(DD_API_SECURITY_SAMPLE_DELAY))
    this._setValue(env, 'appsec.blockedTemplateGraphql', maybeFile(DD_APPSEC_GRAPHQL_BLOCKED_TEMPLATE_JSON))
    this._setValue(env, 'appsec.blockedTemplateHtml', maybeFile(DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML))
    this._envUnprocessed['appsec.blockedTemplateHtml'] = DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML
    this._setValue(env, 'appsec.blockedTemplateJson', maybeFile(DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON))
    this._envUnprocessed['appsec.blockedTemplateJson'] = DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON
    this._setBoolean(env, 'appsec.enabled', DD_APPSEC_ENABLED)
    this._setString(env, 'appsec.eventTracking.mode', DD_APPSEC_AUTO_USER_INSTRUMENTATION_MODE)
    this._setBoolean(env, 'appsec.extendedHeadersCollection.enabled', DD_APPSEC_COLLECT_ALL_HEADERS)
    this._setBoolean(
      env,
      'appsec.extendedHeadersCollection.redaction',
      DD_APPSEC_HEADER_COLLECTION_REDACTION_ENABLED
    )
    this._setValue(env, 'appsec.extendedHeadersCollection.maxHeaders', maybeInt(DD_APPSEC_MAX_COLLECTED_HEADERS))
    this._envUnprocessed['appsec.extendedHeadersCollection.maxHeaders'] = DD_APPSEC_MAX_COLLECTED_HEADERS
    this._setString(env, 'appsec.obfuscatorKeyRegex', DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP)
    this._setString(env, 'appsec.obfuscatorValueRegex', DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP)
    this._setBoolean(env, 'appsec.rasp.enabled', DD_APPSEC_RASP_ENABLED)
    this._setBoolean(env, 'appsec.rasp.bodyCollection', DD_APPSEC_RASP_COLLECT_REQUEST_BODY)
    this._setValue(env, 'appsec.rateLimit', maybeInt(DD_APPSEC_TRACE_RATE_LIMIT))
    this._envUnprocessed['appsec.rateLimit'] = DD_APPSEC_TRACE_RATE_LIMIT
    this._setString(env, 'appsec.rules', DD_APPSEC_RULES)
    // DD_APPSEC_SCA_ENABLED is never used locally, but only sent to the backend
    this._setBoolean(env, 'appsec.sca.enabled', DD_APPSEC_SCA_ENABLED)
    this._setBoolean(env, 'appsec.stackTrace.enabled', DD_APPSEC_STACK_TRACE_ENABLED)
    this._setValue(env, 'appsec.stackTrace.maxDepth', maybeInt(DD_APPSEC_MAX_STACK_TRACE_DEPTH))
    this._envUnprocessed['appsec.stackTrace.maxDepth'] = DD_APPSEC_MAX_STACK_TRACE_DEPTH
    this._setValue(env, 'appsec.stackTrace.maxStackTraces', maybeInt(DD_APPSEC_MAX_STACK_TRACES))
    this._envUnprocessed['appsec.stackTrace.maxStackTraces'] = DD_APPSEC_MAX_STACK_TRACES
    this._setValue(env, 'appsec.wafTimeout', maybeInt(DD_APPSEC_WAF_TIMEOUT))
    this._envUnprocessed['appsec.wafTimeout'] = DD_APPSEC_WAF_TIMEOUT
    this._setValue(env, 'baggageMaxBytes', DD_TRACE_BAGGAGE_MAX_BYTES)
    this._setValue(env, 'baggageMaxItems', DD_TRACE_BAGGAGE_MAX_ITEMS)
    this._setValue(env, 'baggageTagKeys', DD_TRACE_BAGGAGE_TAG_KEYS)
    this._setBoolean(env, 'clientIpEnabled', DD_TRACE_CLIENT_IP_ENABLED)
    this._setString(env, 'clientIpHeader', DD_TRACE_CLIENT_IP_HEADER?.toLowerCase())
    this._setBoolean(env, 'crashtracking.enabled', coalesce(
      DD_CRASHTRACKING_ENABLED,
      !this._isInServerlessEnvironment()
    ))
    this._setBoolean(env, 'codeOriginForSpans.enabled', DD_CODE_ORIGIN_FOR_SPANS_ENABLED)
    this._setBoolean(
      env,
      'codeOriginForSpans.experimental.exit_spans.enabled',
      DD_CODE_ORIGIN_FOR_SPANS_EXPERIMENTAL_EXIT_SPANS_ENABLED
    )
    this._setString(env, 'dbmPropagationMode', DD_DBM_PROPAGATION_MODE)
    this._setString(env, 'dogstatsd.hostname', DD_DOGSTATSD_HOST)
    this._setString(env, 'dogstatsd.port', DD_DOGSTATSD_PORT)
    this._setBoolean(env, 'dsmEnabled', DD_DATA_STREAMS_ENABLED)
    this._setBoolean(env, 'dynamicInstrumentation.enabled', DD_DYNAMIC_INSTRUMENTATION_ENABLED)
    this._setArray(env, 'dynamicInstrumentation.redactedIdentifiers', DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS)
    this._setArray(
      env,
      'dynamicInstrumentation.redactionExcludedIdentifiers',
      DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS
    )
    this._setString(env, 'env', DD_ENV || tags.env)
    this._setBoolean(env, 'traceEnabled', DD_TRACE_ENABLED)
    this._setBoolean(env, 'experimental.enableGetRumData', DD_TRACE_EXPERIMENTAL_GET_RUM_DATA_ENABLED)
    this._setString(env, 'experimental.exporter', DD_TRACE_EXPERIMENTAL_EXPORTER)
    this._setBoolean(env, 'experimental.runtimeId', DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED)
    if (AWS_LAMBDA_FUNCTION_NAME) this._setValue(env, 'flushInterval', 0)
    this._setValue(env, 'flushMinSpans', maybeInt(DD_TRACE_PARTIAL_FLUSH_MIN_SPANS))
    this._envUnprocessed.flushMinSpans = DD_TRACE_PARTIAL_FLUSH_MIN_SPANS
    this._setBoolean(env, 'gitMetadataEnabled', DD_TRACE_GIT_METADATA_ENABLED)
    this._setIntegerRangeSet(env, 'grpc.client.error.statuses', DD_GRPC_CLIENT_ERROR_STATUSES)
    this._setIntegerRangeSet(env, 'grpc.server.error.statuses', DD_GRPC_SERVER_ERROR_STATUSES)
    this._setArray(env, 'headerTags', DD_TRACE_HEADER_TAGS)
    this._setString(env, 'hostname', DD_AGENT_HOST)
    this._setValue(env, 'iast.dbRowsToTaint', maybeInt(DD_IAST_DB_ROWS_TO_TAINT))
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
    this._setString(env, 'iast.securityControlsConfiguration', DD_IAST_SECURITY_CONTROLS_CONFIGURATION)
    this._setString(env, 'iast.telemetryVerbosity', DD_IAST_TELEMETRY_VERBOSITY)
    this._setBoolean(env, 'iast.stackTrace.enabled', DD_IAST_STACK_TRACE_ENABLED)
    this._setArray(env, 'injectionEnabled', DD_INJECTION_ENABLED)
    this._setBoolean(env, 'isAzureFunction', getIsAzureFunction())
    this._setBoolean(env, 'isGCPFunction', getIsGCPFunction())
    this._setValue(env, 'langchain.spanCharLimit', maybeInt(DD_LANGCHAIN_SPAN_CHAR_LIMIT))
    this._setValue(
      env, 'langchain.spanPromptCompletionSampleRate', maybeFloat(DD_LANGCHAIN_SPAN_PROMPT_COMPLETION_SAMPLE_RATE)
    )
    this._setBoolean(env, 'legacyBaggageEnabled', DD_TRACE_LEGACY_BAGGAGE_ENABLED)
    this._setBoolean(env, 'llmobs.agentlessEnabled', DD_LLMOBS_AGENTLESS_ENABLED)
    this._setBoolean(env, 'llmobs.enabled', DD_LLMOBS_ENABLED)
    this._setString(env, 'llmobs.mlApp', DD_LLMOBS_ML_APP)
    this._setBoolean(env, 'logInjection', DD_LOGS_INJECTION)
    // Requires an accompanying DD_APM_OBFUSCATION_MEMCACHED_KEEP_COMMAND=true in the agent
    this._setBoolean(env, 'memcachedCommandEnabled', DD_TRACE_MEMCACHED_COMMAND_ENABLED)
    this._setBoolean(env, 'middlewareTracingEnabled', DD_TRACE_MIDDLEWARE_TRACING_ENABLED)
    this._setBoolean(env, 'openAiLogsEnabled', DD_OPENAI_LOGS_ENABLED)
    this._setValue(env, 'openai.spanCharLimit', maybeInt(DD_OPENAI_SPAN_CHAR_LIMIT))
    this._envUnprocessed.openaiSpanCharLimit = DD_OPENAI_SPAN_CHAR_LIMIT
    if (DD_TRACE_PEER_SERVICE_MAPPING) {
      this._setValue(env, 'peerServiceMapping', Object.fromEntries(
        DD_TRACE_PEER_SERVICE_MAPPING.split(',').map(x => x.trim().split(':'))
      ))
      this._envUnprocessed.peerServiceMapping = DD_TRACE_PEER_SERVICE_MAPPING
    }
    this._setString(env, 'port', DD_TRACE_AGENT_PORT)
    const profilingEnabled = normalizeProfilingEnabledValue(
      coalesce(
        DD_PROFILING_ENABLED,
        this._isInServerlessEnvironment() ? 'false' : undefined
      )
    )
    this._setString(env, 'profiling.enabled', profilingEnabled)
    this._setString(env, 'profiling.exporters', DD_PROFILING_EXPORTERS)
    this._setBoolean(env, 'profiling.sourceMap', DD_PROFILING_SOURCE_MAP && !isFalse(DD_PROFILING_SOURCE_MAP))
    if (DD_INTERNAL_PROFILING_LONG_LIVED_THRESHOLD) {
      // This is only used in testing to not have to wait 30s
      this._setValue(env, 'profiling.longLivedThreshold', Number(DD_INTERNAL_PROFILING_LONG_LIVED_THRESHOLD))
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
    this._setArray(env, 'sampler.spanSamplingRules', reformatSpanSamplingRules(coalesce(
      safeJsonParse(maybeFile(DD_SPAN_SAMPLING_RULES_FILE)),
      safeJsonParse(DD_SPAN_SAMPLING_RULES)
    )))
    this._setUnit(env, 'sampleRate', DD_TRACE_SAMPLE_RATE ||
    getFromOtelSamplerMap(OTEL_TRACES_SAMPLER, OTEL_TRACES_SAMPLER_ARG))
    this._setValue(env, 'sampler.rateLimit', DD_TRACE_RATE_LIMIT)
    this._setSamplingRule(env, 'sampler.rules', safeJsonParse(DD_TRACE_SAMPLING_RULES))
    this._envUnprocessed['sampler.rules'] = DD_TRACE_SAMPLING_RULES
    this._setString(env, 'scope', DD_TRACE_SCOPE)
    this._setString(env, 'service', DD_SERVICE || tags.service || OTEL_SERVICE_NAME)
    if (DD_SERVICE_MAPPING) {
      this._setValue(env, 'serviceMapping', Object.fromEntries(
        DD_SERVICE_MAPPING.split(',').map(x => x.trim().split(':'))
      ))
    }
    this._setString(env, 'site', DD_SITE)
    if (DD_TRACE_SPAN_ATTRIBUTE_SCHEMA) {
      this._setString(env, 'spanAttributeSchema', validateNamingVersion(DD_TRACE_SPAN_ATTRIBUTE_SCHEMA))
      this._envUnprocessed.spanAttributeSchema = DD_TRACE_SPAN_ATTRIBUTE_SCHEMA
    }
    // 0: disabled, 1: logging, 2: garbage collection + logging
    this._setValue(env, 'spanLeakDebug', maybeInt(DD_TRACE_SPAN_LEAK_DEBUG))
    this._setBoolean(env, 'spanRemoveIntegrationFromService', DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED)
    this._setBoolean(env, 'startupLogs', DD_TRACE_STARTUP_LOGS)
    this._setTags(env, 'tags', tags)
    this._setValue(env, 'tagsHeaderMaxLength', DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH)
    this._setBoolean(env, 'telemetry.enabled', coalesce(
      DD_INSTRUMENTATION_TELEMETRY_ENABLED,
      !(this._isInServerlessEnvironment() || JEST_WORKER_ID)
    ))
    this._setString(env, 'instrumentation_config_id', DD_INSTRUMENTATION_CONFIG_ID)
    this._setBoolean(env, 'telemetry.debug', DD_TELEMETRY_DEBUG)
    this._setBoolean(env, 'telemetry.dependencyCollection', DD_TELEMETRY_DEPENDENCY_COLLECTION_ENABLED)
    this._setValue(env, 'telemetry.heartbeatInterval', maybeInt(Math.floor(DD_TELEMETRY_HEARTBEAT_INTERVAL * 1000)))
    this._envUnprocessed['telemetry.heartbeatInterval'] = DD_TELEMETRY_HEARTBEAT_INTERVAL * 1000
    this._setBoolean(env, 'telemetry.logCollection', DD_TELEMETRY_LOG_COLLECTION_ENABLED)
    this._setBoolean(env, 'telemetry.metrics', DD_TELEMETRY_METRICS_ENABLED)
    this._setBoolean(env, 'traceId128BitGenerationEnabled', DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED)
    this._setBoolean(env, 'traceId128BitLoggingEnabled', DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED)
    this._setBoolean(env, 'tracePropagationExtractFirst', DD_TRACE_PROPAGATION_EXTRACT_FIRST)
    const stringPropagationBehaviorExtract = String(DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT)
    this._setValue(env, 'tracePropagationBehaviorExtract',
      VALID_PROPAGATION_BEHAVIOR_EXTRACT.has(stringPropagationBehaviorExtract)
        ? stringPropagationBehaviorExtract
        : 'continue')
    this._setBoolean(env, 'tracePropagationStyle.otelPropagators',
      DD_TRACE_PROPAGATION_STYLE ||
      DD_TRACE_PROPAGATION_STYLE_INJECT ||
      DD_TRACE_PROPAGATION_STYLE_EXTRACT
        ? false
        : !!OTEL_PROPAGATORS)
    this._setBoolean(env, 'tracing', DD_TRACING_ENABLED)
    this._setString(env, 'version', DD_VERSION || tags.version)
    this._setBoolean(env, 'inferredProxyServicesEnabled', DD_TRACE_INFERRED_PROXY_SERVICES_ENABLED)
    this._setBoolean(env, 'trace.aws.addSpanPointers', DD_TRACE_AWS_ADD_SPAN_POINTERS)
    this._setString(env, 'trace.dynamoDb.tablePrimaryKeys', DD_TRACE_DYNAMODB_TABLE_PRIMARY_KEYS)
    this._setArray(env, 'graphqlErrorExtensions', DD_TRACE_GRAPHQL_ERROR_EXTENSIONS)
    this._setBoolean(env, 'trace.nativeSpanEvents', DD_TRACE_NATIVE_SPAN_EVENTS)
    this._setValue(
      env,
      'vertexai.spanPromptCompletionSampleRate',
      maybeFloat(DD_VERTEXAI_SPAN_PROMPT_COMPLETION_SAMPLE_RATE)
    )
    this._setValue(env, 'vertexai.spanCharLimit', maybeInt(DD_VERTEXAI_SPAN_CHAR_LIMIT))
  }

  _applyOptions (options) {
    const opts = setHiddenProperty(this, '_options', this._options || {})
    const tags = {}
    setHiddenProperty(this, '_optsUnprocessed', {})

    options = setHiddenProperty(this, '_optionsArg', { ingestion: {}, ...options, ...opts })

    tagger.add(tags, options.tags)

    this._setBoolean(opts, 'apmTracingEnabled', coalesce(
      options.apmTracingEnabled,
      options.experimental?.appsec?.standalone && !options.experimental.appsec.standalone.enabled
    ))
    this._setBoolean(opts, 'appsec.apiSecurity.enabled', options.appsec?.apiSecurity?.enabled)
    this._setValue(opts, 'appsec.blockedTemplateGraphql', maybeFile(options.appsec?.blockedTemplateGraphql))
    this._setValue(opts, 'appsec.blockedTemplateHtml', maybeFile(options.appsec?.blockedTemplateHtml))
    this._optsUnprocessed['appsec.blockedTemplateHtml'] = options.appsec?.blockedTemplateHtml
    this._setValue(opts, 'appsec.blockedTemplateJson', maybeFile(options.appsec?.blockedTemplateJson))
    this._optsUnprocessed['appsec.blockedTemplateJson'] = options.appsec?.blockedTemplateJson
    this._setBoolean(opts, 'appsec.enabled', options.appsec?.enabled)
    this._setString(opts, 'appsec.eventTracking.mode', options.appsec?.eventTracking?.mode)
    this._setBoolean(
      opts,
      'appsec.extendedHeadersCollection.enabled',
      options.appsec?.extendedHeadersCollection?.enabled
    )
    this._setBoolean(
      opts,
      'appsec.extendedHeadersCollection.redaction',
      options.appsec?.extendedHeadersCollection?.redaction
    )
    this._setValue(opts,
      'appsec.extendedHeadersCollection.maxHeaders',
      options.appsec?.extendedHeadersCollection?.maxHeaders
    )
    this._setString(opts, 'appsec.obfuscatorKeyRegex', options.appsec?.obfuscatorKeyRegex)
    this._setString(opts, 'appsec.obfuscatorValueRegex', options.appsec?.obfuscatorValueRegex)
    this._setBoolean(opts, 'appsec.rasp.enabled', options.appsec?.rasp?.enabled)
    this._setBoolean(opts, 'appsec.rasp.bodyCollection', options.appsec?.rasp?.bodyCollection)
    this._setValue(opts, 'appsec.rateLimit', maybeInt(options.appsec?.rateLimit))
    this._optsUnprocessed['appsec.rateLimit'] = options.appsec?.rateLimit
    this._setString(opts, 'appsec.rules', options.appsec?.rules)
    this._setBoolean(opts, 'appsec.stackTrace.enabled', options.appsec?.stackTrace?.enabled)
    this._setValue(opts, 'appsec.stackTrace.maxDepth', maybeInt(options.appsec?.stackTrace?.maxDepth))
    this._optsUnprocessed['appsec.stackTrace.maxDepth'] = options.appsec?.stackTrace?.maxDepth
    this._setValue(opts, 'appsec.stackTrace.maxStackTraces', maybeInt(options.appsec?.stackTrace?.maxStackTraces))
    this._optsUnprocessed['appsec.stackTrace.maxStackTraces'] = options.appsec?.stackTrace?.maxStackTraces
    this._setValue(opts, 'appsec.wafTimeout', maybeInt(options.appsec?.wafTimeout))
    this._optsUnprocessed['appsec.wafTimeout'] = options.appsec?.wafTimeout
    this._setBoolean(opts, 'clientIpEnabled', options.clientIpEnabled)
    this._setString(opts, 'clientIpHeader', options.clientIpHeader?.toLowerCase())
    this._setValue(opts, 'baggageMaxBytes', options.baggageMaxBytes)
    this._setValue(opts, 'baggageMaxItems', options.baggageMaxItems)
    this._setValue(opts, 'baggageTagKeys', options.baggageTagKeys)
    this._setBoolean(opts, 'codeOriginForSpans.enabled', options.codeOriginForSpans?.enabled)
    this._setBoolean(
      opts,
      'codeOriginForSpans.experimental.exit_spans.enabled',
      options.codeOriginForSpans?.experimental?.exit_spans?.enabled
    )
    this._setString(opts, 'dbmPropagationMode', options.dbmPropagationMode)
    if (options.dogstatsd) {
      this._setString(opts, 'dogstatsd.hostname', options.dogstatsd.hostname)
      this._setString(opts, 'dogstatsd.port', options.dogstatsd.port)
    }
    this._setBoolean(opts, 'dsmEnabled', options.dsmEnabled)
    this._setBoolean(opts, 'dynamicInstrumentation.enabled', options.dynamicInstrumentation?.enabled)
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
    this._setString(opts, 'env', options.env || tags.env)
    this._setBoolean(opts, 'experimental.enableGetRumData', options.experimental?.enableGetRumData)
    this._setString(opts, 'experimental.exporter', options.experimental?.exporter)
    this._setBoolean(opts, 'experimental.runtimeId', options.experimental?.runtimeId)
    this._setValue(opts, 'flushInterval', maybeInt(options.flushInterval))
    this._optsUnprocessed.flushInterval = options.flushInterval
    this._setValue(opts, 'flushMinSpans', maybeInt(options.flushMinSpans))
    this._optsUnprocessed.flushMinSpans = options.flushMinSpans
    this._setArray(opts, 'headerTags', options.headerTags)
    this._setString(opts, 'hostname', options.hostname)
    this._setValue(opts, 'iast.dbRowsToTaint', maybeInt(options.iast?.dbRowsToTaint))
    this._setBoolean(opts, 'iast.deduplicationEnabled', options.iast && options.iast.deduplicationEnabled)
    this._setBoolean(opts, 'iast.enabled',
      options.iast && (options.iast === true || options.iast.enabled === true))
    this._setValue(opts, 'iast.maxConcurrentRequests',
      maybeInt(options.iast?.maxConcurrentRequests))
    this._optsUnprocessed['iast.maxConcurrentRequests'] = options.iast?.maxConcurrentRequests
    this._setValue(opts, 'iast.maxContextOperations', maybeInt(options.iast?.maxContextOperations))
    this._optsUnprocessed['iast.maxContextOperations'] = options.iast?.maxContextOperations
    this._setBoolean(opts, 'iast.redactionEnabled', options.iast?.redactionEnabled)
    this._setString(opts, 'iast.redactionNamePattern', options.iast?.redactionNamePattern)
    this._setString(opts, 'iast.redactionValuePattern', options.iast?.redactionValuePattern)
    const iastRequestSampling = maybeInt(options.iast?.requestSampling)
    if (iastRequestSampling > -1 && iastRequestSampling < 101) {
      this._setValue(opts, 'iast.requestSampling', iastRequestSampling)
      this._optsUnprocessed['iast.requestSampling'] = options.iast?.requestSampling
    }
    this._setValue(opts, 'iast.securityControlsConfiguration', options.iast?.securityControlsConfiguration)
    this._setBoolean(opts, 'iast.stackTrace.enabled', options.iast?.stackTrace?.enabled)
    this._setString(opts, 'iast.telemetryVerbosity', options.iast && options.iast.telemetryVerbosity)
    this._setBoolean(opts, 'isCiVisibility', options.isCiVisibility)
    this._setBoolean(opts, 'legacyBaggageEnabled', options.legacyBaggageEnabled)
    this._setBoolean(opts, 'llmobs.agentlessEnabled', options.llmobs?.agentlessEnabled)
    this._setString(opts, 'llmobs.mlApp', options.llmobs?.mlApp)
    this._setBoolean(opts, 'logInjection', options.logInjection)
    this._setValue(opts, 'lookup', options.lookup)
    this._setBoolean(opts, 'middlewareTracingEnabled', options.middlewareTracingEnabled)
    this._setBoolean(opts, 'openAiLogsEnabled', options.openAiLogsEnabled)
    this._setValue(opts, 'peerServiceMapping', options.peerServiceMapping)
    this._setBoolean(opts, 'plugins', options.plugins)
    this._setString(opts, 'port', options.port)
    const strProfiling = String(options.profiling)
    if (['true', 'false', 'auto'].includes(strProfiling)) {
      this._setString(opts, 'profiling.enabled', strProfiling)
    }
    this._setString(opts, 'protocolVersion', options.protocolVersion)
    if (options.remoteConfig) {
      this._setValue(opts, 'remoteConfig.pollInterval', maybeFloat(options.remoteConfig.pollInterval))
      this._optsUnprocessed['remoteConfig.pollInterval'] = options.remoteConfig.pollInterval
    }
    this._setBoolean(opts, 'reportHostname', options.reportHostname)
    this._setBoolean(opts, 'runtimeMetrics', options.runtimeMetrics)
    this._setArray(opts, 'sampler.spanSamplingRules', reformatSpanSamplingRules(options.spanSamplingRules))
    this._setUnit(opts, 'sampleRate', coalesce(options.sampleRate, options.ingestion.sampleRate))
    const ingestion = options.ingestion || {}
    this._setValue(opts, 'sampler.rateLimit', coalesce(options.rateLimit, ingestion.rateLimit))
    this._setSamplingRule(opts, 'sampler.rules', options.samplingRules)
    this._setString(opts, 'service', options.service || tags.service)
    this._setValue(opts, 'serviceMapping', options.serviceMapping)
    this._setString(opts, 'site', options.site)
    if (options.spanAttributeSchema) {
      this._setString(opts, 'spanAttributeSchema', validateNamingVersion(options.spanAttributeSchema))
      this._optsUnprocessed.spanAttributeSchema = options.spanAttributeSchema
    }
    this._setBoolean(opts, 'spanRemoveIntegrationFromService', options.spanRemoveIntegrationFromService)
    this._setBoolean(opts, 'startupLogs', options.startupLogs)
    this._setTags(opts, 'tags', tags)
    this._setBoolean(opts, 'traceId128BitGenerationEnabled', options.traceId128BitGenerationEnabled)
    this._setBoolean(opts, 'traceId128BitLoggingEnabled', options.traceId128BitLoggingEnabled)
    this._setString(opts, 'version', options.version || tags.version)
    this._setBoolean(opts, 'inferredProxyServicesEnabled', options.inferredProxyServicesEnabled)
    this._setBoolean(opts, 'graphqlErrorExtensions', options.graphqlErrorExtensions)
    this._setBoolean(opts, 'trace.nativeSpanEvents', options.trace?.nativeSpanEvents)

    // For LLMObs, we want the environment variable to take precedence over the options.
    // This is reliant on environment config being set before options.
    // This is to make sure the origins of each value are tracked appropriately for telemetry.
    // We'll only set `llmobs.enabled` on the opts when it's not set on the environment, and options.llmobs is provided.
    const llmobsEnabledEnv = this._env['llmobs.enabled']
    if (llmobsEnabledEnv == null && options.llmobs) {
      this._setBoolean(opts, 'llmobs.enabled', !!options.llmobs)
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
      getEnvironmentVariable('DD_CIVISIBILITY_ITR_ENABLED'),
      true
    )
  }

  _getHostname () {
    const DD_CIVISIBILITY_AGENTLESS_URL = getEnvironmentVariable('DD_CIVISIBILITY_AGENTLESS_URL')
    const url = DD_CIVISIBILITY_AGENTLESS_URL
      ? new URL(DD_CIVISIBILITY_AGENTLESS_URL)
      : getAgentUrl(this._getTraceAgentUrl(), this._optionsArg)
    const DD_AGENT_HOST = coalesce(
      this._optionsArg.hostname,
      getEnvironmentVariable('DD_AGENT_HOST'),
      '127.0.0.1'
    )
    return DD_AGENT_HOST || (url && url.hostname)
  }

  _getSpanComputePeerService () {
    const DD_TRACE_SPAN_ATTRIBUTE_SCHEMA = validateNamingVersion(
      coalesce(
        this._optionsArg.spanAttributeSchema,
        getEnvironmentVariable('DD_TRACE_SPAN_ATTRIBUTE_SCHEMA')
      )
    )

    const peerServiceSet = (
      this._optionsArg.hasOwnProperty('spanComputePeerService') ||
      getEnvironmentVariables().hasOwnProperty('DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED')
    )
    const peerServiceValue = coalesce(
      this._optionsArg.spanComputePeerService,
      getEnvironmentVariable('DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED')
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
      getEnvironmentVariable('DD_CIVISIBILITY_GIT_UPLOAD_ENABLED'),
      true
    )
  }

  _isCiVisibilityManualApiEnabled () {
    return coalesce(
      getEnvironmentVariable('DD_CIVISIBILITY_MANUAL_API_ENABLED'),
      true
    )
  }

  _isTraceStatsComputationEnabled () {
    const apmTracingEnabled = this._options.apmTracingEnabled !== false &&
      this._env.apmTracingEnabled !== false

    return apmTracingEnabled && coalesce(
      this._optionsArg.stats,
      getEnvironmentVariable('DD_TRACE_STATS_COMPUTATION_ENABLED'),
      getIsGCPFunction() || getIsAzureFunction()
    )
  }

  _getTraceAgentUrl () {
    return coalesce(
      this._optionsArg.url,
      getEnvironmentVariable('DD_TRACE_AGENT_URL'),
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
      DD_TEST_MANAGEMENT_ATTEMPT_TO_FIX_RETRIES,
      DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED
    } = getEnvironmentVariables()

    if (DD_CIVISIBILITY_AGENTLESS_URL) {
      this._setValue(calc, 'url', new URL(DD_CIVISIBILITY_AGENTLESS_URL))
    } else {
      this._setValue(calc, 'url', getAgentUrl(this._getTraceAgentUrl(), this._optionsArg))
    }
    if (this._isCiVisibility()) {
      this._setBoolean(calc, 'isEarlyFlakeDetectionEnabled',
        coalesce(DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED, true))
      this._setBoolean(calc, 'isFlakyTestRetriesEnabled',
        coalesce(DD_CIVISIBILITY_FLAKY_RETRY_ENABLED, true))
      this._setValue(calc, 'flakyTestRetriesCount', coalesce(maybeInt(DD_CIVISIBILITY_FLAKY_RETRY_COUNT), 5))
      this._setBoolean(calc, 'isIntelligentTestRunnerEnabled', isTrue(this._isCiVisibilityItrEnabled()))
      this._setBoolean(calc, 'isManualApiEnabled', !isFalse(this._isCiVisibilityManualApiEnabled()))
      this._setString(calc, 'ciVisibilityTestSessionName', DD_TEST_SESSION_NAME)
      this._setBoolean(calc, 'ciVisAgentlessLogSubmissionEnabled', isTrue(DD_AGENTLESS_LOG_SUBMISSION_ENABLED))
      this._setBoolean(calc, 'isTestDynamicInstrumentationEnabled', !isFalse(DD_TEST_FAILED_TEST_REPLAY_ENABLED))
      this._setBoolean(calc, 'isServiceUserProvided', !!this._env.service)
      this._setBoolean(calc, 'isTestManagementEnabled', !isFalse(DD_TEST_MANAGEMENT_ENABLED))
      this._setValue(calc,
        'testManagementAttemptToFixRetries',
        coalesce(maybeInt(DD_TEST_MANAGEMENT_ATTEMPT_TO_FIX_RETRIES), 20)
      )
      this._setBoolean(calc, 'isImpactedTestsEnabled', !isFalse(DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED))
    }
    this._setString(calc, 'dogstatsd.hostname', this._getHostname())
    this._setBoolean(calc, 'isGitUploadEnabled',
      calc.isIntelligentTestRunnerEnabled && !isFalse(this._isCiVisibilityGitUploadEnabled()))
    this._setBoolean(calc, 'spanComputePeerService', this._getSpanComputePeerService())
    this._setBoolean(calc, 'stats.enabled', this._isTraceStatsComputationEnabled())
    const defaultPropagationStyle = this._getDefaultPropagationStyle(this._optionsArg)
    this._setValue(calc, 'tracePropagationStyle.inject', propagationStyle(
      'inject',
      this._optionsArg.tracePropagationStyle
    ))
    this._setValue(calc, 'tracePropagationStyle.extract', propagationStyle(
      'extract',
      this._optionsArg.tracePropagationStyle
    ))
    if (defaultPropagationStyle.length > 2) {
      calc['tracePropagationStyle.inject'] = calc['tracePropagationStyle.inject'] || defaultPropagationStyle
      calc['tracePropagationStyle.extract'] = calc['tracePropagationStyle.extract'] || defaultPropagationStyle
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
    this._setBoolean(opts, 'logInjection', options.log_injection_enabled)
    this._setArray(opts, 'headerTags', headerTags)
    this._setTags(opts, 'tags', tags)
    this._setBoolean(opts, 'tracing', options.tracing_enabled)
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

    value = Number.parseFloat(value)

    if (!Number.isNaN(value)) {
      // TODO: Ignore out of range values instead of normalizing them.
      this._setValue(obj, name, Math.min(Math.max(value, 0), 1))
    }
  }

  _setArray (obj, name, value) {
    if (value == null) {
      return this._setValue(obj, name, null)
    }

    if (typeof value === 'string') {
      value = value.split(',').map(item => {
        // Trim each item and remove whitespace around the colon
        const [key, val] = item.split(':').map(part => part.trim())
        return val === undefined ? key : `${key}:${val}`
      })
    }

    if (Array.isArray(value)) {
      this._setValue(obj, name, value)
    }
  }

  _setIntegerRangeSet (obj, name, value) {
    if (value == null) {
      return this._setValue(obj, name, null)
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
    this._setValue(obj, name, result)
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

  _getContainersAndOriginsOrdered () {
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

    return { containers, origins }
  }

  // TODO: Report origin changes and errors to telemetry.
  // TODO: Deeply merge configurations.
  // TODO: Move change tracking to telemetry.
  // for telemetry reporting, `name`s in `containers` need to be keys from:
  // https://github.com/DataDog/dd-go/blob/prod/trace/apps/tracer-telemetry-intake/telemetry-payload/static/config_norm_rules.json
  _merge () {
    const { containers, origins } = this._getContainersAndOriginsOrdered()
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

  getOrigin (name) {
    const { containers, origins } = this._getContainersAndOriginsOrdered()

    for (let i = 0; i < containers.length; i++) {
      const container = containers[i]
      const value = container[name]
      if (value != null || container === this._defaults) {
        return origins[i]
      }
    }
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
    .replaceAll('=', ':')
}

function parseSpaceSeparatedTags (tagString) {
  if (tagString && !tagString.includes(',')) {
    tagString = tagString.replaceAll(/\s+/g, ',')
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
    !getEnvironmentVariable('DD_AGENT_HOST') &&
    !getEnvironmentVariable('DD_TRACE_AGENT_PORT') &&
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
