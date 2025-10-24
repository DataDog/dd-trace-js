'use strict'

const fs = require('fs')
const os = require('os')
const uuid = require('crypto-randomuuid') // we need to keep the old uuid dep because of cypress
const { URL } = require('url')
const log = require('./log')
const tagger = require('./tagger')
const set = require('../../datadog-core/src/utils/src/set')
const { isTrue, isFalse, normalizeProfilingEnabledValue } = require('./util')
const { GIT_REPOSITORY_URL, GIT_COMMIT_SHA } = require('./plugins/util/tags')
const { getGitMetadataFromGitProperties, removeUserSensitiveInfo, getRemoteOriginURL, resolveGitHeadSHA } =
  require('./git_properties')
const { updateConfig } = require('./telemetry')
const telemetryMetrics = require('./telemetry/metrics')
const { isInServerlessEnvironment, getIsGCPFunction, getIsAzureFunction } = require('./serverless')
const { ORIGIN_KEY } = require('./constants')
const { appendRules } = require('./payload-tagging/config')
const { getEnvironmentVariable: getEnv, getEnvironmentVariables } = require('./config-helper')
const defaults = require('./config_defaults')
const path = require('path')

const tracerMetrics = telemetryMetrics.manager.namespace('tracers')

const changeTracker = {}

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

const DEFAULT_OTLP_PORT = 4318

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
  if (!getEnv('PROPAGATION_STYLE_EXTRACT') &&
    !getEnv('PROPAGATION_STYLE_INJECT') &&
    !getEnv('DD_TRACE_PROPAGATION_STYLE') &&
    getEnv('OTEL_PROPAGATORS')) {
    for (const style in propagators) {
      if (!VALID_PROPAGATION_STYLES.has(style)) {
        log.warn('unexpected value for OTEL_PROPAGATORS environment variable')
        getCounter('otel.env.invalid', 'DD_TRACE_PROPAGATION_STYLE', 'OTEL_PROPAGATORS').inc()
      }
    }
  }
}

/**
 * Validate the type of an environment variable
 * @param {string} envVar - The name of the environment variable
 * @param {string} [value] - The value of the environment variable
 * @returns {boolean} - True if the value is valid, false otherwise
 */
function isInvalidOtelEnvironmentVariable (envVar, value) {
  // Skip validation if the value is undefined (it was not set as environment variable)
  if (value === undefined) return false

  switch (envVar) {
    case 'OTEL_LOG_LEVEL':
      return !VALID_LOG_LEVELS.has(value)
    case 'OTEL_PROPAGATORS':
    case 'OTEL_RESOURCE_ATTRIBUTES':
    case 'OTEL_SERVICE_NAME':
      return typeof value !== 'string'
    case 'OTEL_TRACES_SAMPLER':
      return getFromOtelSamplerMap(value, getEnv('OTEL_TRACES_SAMPLER_ARG')) === undefined
    case 'OTEL_TRACES_SAMPLER_ARG':
      return Number.isNaN(Number.parseFloat(value))
    case 'OTEL_SDK_DISABLED':
      return value.toLowerCase() !== 'true' && value.toLowerCase() !== 'false'
    case 'OTEL_TRACES_EXPORTER':
    case 'OTEL_METRICS_EXPORTER':
    case 'OTEL_LOGS_EXPORTER':
      return value.toLowerCase() !== 'none'
    default:
      return true
  }
}

function checkIfBothOtelAndDdEnvVarSet () {
  for (const [otelEnvVar, ddEnvVar] of Object.entries(otelDdEnvMapping)) {
    const otelValue = getEnv(otelEnvVar)

    if (ddEnvVar && getEnv(ddEnvVar) && otelValue) {
      log.warn('both %s and %s environment variables are set', ddEnvVar, otelEnvVar)
      getCounter('otel.env.hiding', ddEnvVar, otelEnvVar).inc()
    }

    if (isInvalidOtelEnvironmentVariable(otelEnvVar, otelValue)) {
      log.warn('unexpected value %s for %s environment variable', otelValue, otelEnvVar)
      getCounter('otel.env.invalid', ddEnvVar, otelEnvVar).inc()
    }
  }
}

const runtimeId = uuid()

function maybeFile (filepath) {
  if (!filepath) return
  try {
    return fs.readFileSync(filepath, 'utf8')
  } catch (e) {
    log.error('Error reading file %s', filepath, e)
  }
}

function maybeJsonFile (filepath) {
  const file = maybeFile(filepath)
  if (!file) return
  try {
    return JSON.parse(file)
  } catch (e) {
    log.error('Error parsing JSON file %s', filepath, e)
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
    log.warn('Unexpected input for config.spanAttributeSchema, picked default', defaultNamingVersion)
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

  const envVar = getEnv(envKey) ??
    getEnv('DD_TRACE_PROPAGATION_STYLE') ??
    getEnv('OTEL_PROPAGATORS')
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
  /**
   * parsed DD_TAGS, usable as a standalone tag set across products
   * @type {Record<string, string> | undefined}
   */
  #parsedDdTags = {}

  #envUnprocessed = {}
  #optsUnprocessed = {}
  #remoteUnprocessed = {}
  #env = {}
  #options = {}
  #remote = {}
  #defaults = {}
  #optionsArg = {}
  #localStableConfig = {}
  #fleetStableConfig = {}
  #calculated = {}

  #getSourcesInOrder () {
    return [
      { container: this.#remote, origin: 'remote_config', unprocessed: this.#remoteUnprocessed },
      { container: this.#options, origin: 'code', unprocessed: this.#optsUnprocessed },
      { container: this.#fleetStableConfig, origin: 'fleet_stable_config' },
      { container: this.#env, origin: 'env_var', unprocessed: this.#envUnprocessed },
      { container: this.#localStableConfig, origin: 'local_stable_config' },
      { container: this.#calculated, origin: 'calculated' },
      { container: this.#defaults, origin: 'default' }
    ]
  }

  constructor (options = {}) {
    if (!isInServerlessEnvironment()) {
      // Bail out early if we're in a serverless environment, stable config isn't supported
      const StableConfig = require('./config_stable')
      this.stableConfig = new StableConfig()
    }

    const envs = getEnvironmentVariables()

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
    this.logger = options.logger ?? logConfig.logger
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

    const {
      DD_API_KEY,
      DD_APP_KEY,
      DD_INSTRUMENTATION_INSTALL_ID = null,
      DD_INSTRUMENTATION_INSTALL_TIME = null,
      DD_INSTRUMENTATION_INSTALL_TYPE = null,
      DD_TRACE_CLOUD_PAYLOAD_TAGGING_MAX_DEPTH,
      DD_TRACE_CLOUD_REQUEST_PAYLOAD_TAGGING,
      DD_TRACE_CLOUD_RESPONSE_PAYLOAD_TAGGING,
      DD_TRACE_PROPAGATION_STYLE_EXTRACT,
      DD_TRACE_PROPAGATION_STYLE_INJECT,
      DD_TRACE_PROPAGATION_STYLE,
    } = envs

    if (DD_TRACE_PROPAGATION_STYLE && (
      DD_TRACE_PROPAGATION_STYLE_INJECT ||
      DD_TRACE_PROPAGATION_STYLE_EXTRACT
    )) {
      log.warn(
        // eslint-disable-next-line @stylistic/max-len
        'Use either the DD_TRACE_PROPAGATION_STYLE environment variable or separate DD_TRACE_PROPAGATION_STYLE_INJECT and DD_TRACE_PROPAGATION_STYLE_EXTRACT environment variables'
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

    if (typeof options.runtimeMetrics === 'boolean') {
      options.runtimeMetrics = {
        enabled: options.runtimeMetrics
      }
    }

    const cloudPayloadTaggingRequestRules = splitJSONPathRules(
      DD_TRACE_CLOUD_REQUEST_PAYLOAD_TAGGING ??
      options.cloudPayloadTagging?.request ??
      ''
    )

    const cloudPayloadTaggingResponseRules = splitJSONPathRules(
      DD_TRACE_CLOUD_RESPONSE_PAYLOAD_TAGGING ??
      options.cloudPayloadTagging?.response ??
      ''
    )

    const cloudPayloadTaggingMaxDepth = maybeInt(
      DD_TRACE_CLOUD_PAYLOAD_TAGGING_MAX_DEPTH ??
      options.cloudPayloadTagging?.maxDepth
    ) ?? 10

    // TODO: refactor
    this.apiKey = DD_API_KEY
    this.appKey = DD_APP_KEY

    // sent in telemetry event app-started
    this.installSignature = {
      id: DD_INSTRUMENTATION_INSTALL_ID,
      time: DD_INSTRUMENTATION_INSTALL_TIME,
      type: DD_INSTRUMENTATION_INSTALL_TYPE
    }

    this.cloudPayloadTagging = {
      requestsEnabled: !!cloudPayloadTaggingRequestRules,
      responsesEnabled: !!cloudPayloadTaggingResponseRules,
      maxDepth: cloudPayloadTaggingMaxDepth,
      rules: appendRules(cloudPayloadTaggingRequestRules, cloudPayloadTaggingResponseRules)
    }

    this.#defaults = defaults
    this.#applyStableConfig(this.stableConfig?.localEntries ?? {}, this.#localStableConfig)
    this.#applyEnvironment(envs)
    this.#applyStableConfig(this.stableConfig?.fleetEntries ?? {}, this.#fleetStableConfig)
    this.#applyOptions(options)
    this.#applyCalculated()
    this.#applyRemote({})
    this.#merge()

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
      this.#loadGitMetadata(envs)
    }
  }

  get parsedDdTags () {
    return this.#parsedDdTags
  }

  // Supports only a subset of options for now.
  configure (options, remote) {
    if (remote) {
      this.#applyRemote(options)
    } else {
      this.#applyOptions(options)
    }

    // TODO: test
    this.#applyCalculated()
    this.#merge()
  }

  #getDefaultPropagationStyle (options) {
    // TODO: Remove the experimental env vars as a major?
    const DD_TRACE_B3_ENABLED = options.experimental?.b3 ??
      getEnv('DD_TRACE_EXPERIMENTAL_B3_ENABLED')
    const defaultPropagationStyle = ['datadog', 'tracecontext']
    if (isTrue(DD_TRACE_B3_ENABLED)) {
      defaultPropagationStyle.push('b3', 'b3 single header')
    }
    return defaultPropagationStyle
  }

  _isInServerlessEnvironment () {
    return isInServerlessEnvironment()
  }

  #applyStableConfig (config, obj) {
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

    this.#setBoolean(obj, 'appsec.enabled', DD_APPSEC_ENABLED)
    this.#setBoolean(obj, 'appsec.sca.enabled', DD_APPSEC_SCA_ENABLED)
    this.#setBoolean(obj, 'dsmEnabled', DD_DATA_STREAMS_ENABLED)
    this.#setBoolean(obj, 'dynamicInstrumentation.enabled', DD_DYNAMIC_INSTRUMENTATION_ENABLED)
    this.#setString(obj, 'env', DD_ENV)
    this.#setBoolean(obj, 'iast.enabled', DD_IAST_ENABLED)
    this.#setBoolean(obj, 'logInjection', DD_LOGS_INJECTION)
    const profilingEnabled = normalizeProfilingEnabledValue(DD_PROFILING_ENABLED)
    this.#setString(obj, 'profiling.enabled', profilingEnabled)
    this.#setBoolean(obj, 'runtimeMetrics.enabled', DD_RUNTIME_METRICS_ENABLED)
    this.#setString(obj, 'service', DD_SERVICE)
    this.#setString(obj, 'version', DD_VERSION)
  }

  #applyEnvironment (envs) {
    const {
      AWS_LAMBDA_FUNCTION_NAME,
      DD_AGENT_HOST,
      DD_AI_GUARD_ENABLED,
      DD_AI_GUARD_ENDPOINT,
      DD_AI_GUARD_MAX_CONTENT_SIZE,
      DD_AI_GUARD_MAX_MESSAGES_LENGTH,
      DD_AI_GUARD_TIMEOUT,
      DD_API_SECURITY_ENABLED,
      DD_API_SECURITY_SAMPLE_DELAY,
      DD_API_SECURITY_ENDPOINT_COLLECTION_ENABLED,
      DD_API_SECURITY_ENDPOINT_COLLECTION_MESSAGE_LIMIT,
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
      DD_DYNAMIC_INSTRUMENTATION_PROBE_FILE,
      DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS,
      DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS,
      DD_DYNAMIC_INSTRUMENTATION_UPLOAD_INTERVAL_SECONDS,
      DD_ENV,
      DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED,
      DD_PROFILING_ENABLED,
      DD_GRPC_CLIENT_ERROR_STATUSES,
      DD_GRPC_SERVER_ERROR_STATUSES,
      JEST_WORKER_ID,
      DD_HEAP_SNAPSHOT_COUNT,
      DD_HEAP_SNAPSHOT_DESTINATION,
      DD_HEAP_SNAPSHOT_INTERVAL,
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
      DD_INJECT_FORCE,
      DD_INSTRUMENTATION_TELEMETRY_ENABLED,
      DD_INSTRUMENTATION_CONFIG_ID,
      DD_LOGS_INJECTION,
      DD_LOGS_OTEL_ENABLED,
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
      DD_RUNTIME_METRICS_EVENT_LOOP_ENABLED,
      DD_RUNTIME_METRICS_GC_ENABLED,
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
      DD_RUNTIME_METRICS_RUNTIME_ID_ENABLED,
      DD_TRACE_GIT_METADATA_ENABLED,
      DD_TRACE_GLOBAL_TAGS,
      DD_TRACE_GRAPHQL_ERROR_EXTENSIONS,
      DD_TRACE_HEADER_TAGS,
      DD_TRACE_LEGACY_BAGGAGE_ENABLED,
      DD_TRACE_MEMCACHED_COMMAND_ENABLED,
      DD_TRACE_MIDDLEWARE_TRACING_ENABLED,
      DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP,
      DD_TRACE_PARTIAL_FLUSH_MIN_SPANS,
      DD_TRACE_FLUSH_INTERVAL,
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
      DD_TRACE_WEBSOCKET_MESSAGES_ENABLED,
      DD_TRACE_WEBSOCKET_MESSAGES_INHERIT_SAMPLING,
      DD_TRACE_WEBSOCKET_MESSAGES_SEPARATE_TRACES,
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
      OTEL_TRACES_SAMPLER_ARG,
      DD_EXPERIMENTAL_FLAGGING_PROVIDER_ENABLED,
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
      OTEL_EXPORTER_OTLP_LOGS_HEADERS,
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL,
      OTEL_EXPORTER_OTLP_LOGS_TIMEOUT,
      OTEL_EXPORTER_OTLP_PROTOCOL,
      OTEL_EXPORTER_OTLP_ENDPOINT,
      OTEL_EXPORTER_OTLP_HEADERS,
      OTEL_EXPORTER_OTLP_TIMEOUT,
      OTEL_BSP_SCHEDULE_DELAY,
      OTEL_BSP_MAX_EXPORT_BATCH_SIZE
    } = envs

    const tags = {}
    const env = this.#env

    tagger.add(this.#parsedDdTags, parseSpaceSeparatedTags(DD_TAGS))

    tagger.add(tags, parseSpaceSeparatedTags(handleOtel(OTEL_RESOURCE_ATTRIBUTES)))
    tagger.add(tags, this.#parsedDdTags)
    tagger.add(tags, DD_TRACE_TAGS)
    tagger.add(tags, DD_TRACE_GLOBAL_TAGS)

    this.#setBoolean(env, 'otelLogsEnabled', isTrue(DD_LOGS_OTEL_ENABLED))
    // Set OpenTelemetry logs configuration with specific _LOGS_ vars taking precedence over generic _EXPORTERS_ vars
    if (OTEL_EXPORTER_OTLP_ENDPOINT) {
      // Only set if there's a custom URL, otherwise let calc phase handle the default
      this.#setString(env, 'otelUrl', OTEL_EXPORTER_OTLP_ENDPOINT)
    }
    if (OTEL_EXPORTER_OTLP_ENDPOINT || OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) {
      this.#setString(env, 'otelLogsUrl', OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || env.otelUrl)
    }
    this.#setString(env, 'otelHeaders', OTEL_EXPORTER_OTLP_HEADERS)
    this.#setString(env, 'otelLogsHeaders', OTEL_EXPORTER_OTLP_LOGS_HEADERS || env.otelHeaders)
    this.#setString(env, 'otelProtocol', OTEL_EXPORTER_OTLP_PROTOCOL)
    this.#setString(env, 'otelLogsProtocol', OTEL_EXPORTER_OTLP_LOGS_PROTOCOL || env.otelProtocol)
    env.otelTimeout = maybeInt(OTEL_EXPORTER_OTLP_TIMEOUT)
    env.otelLogsTimeout = maybeInt(OTEL_EXPORTER_OTLP_LOGS_TIMEOUT) || env.otelTimeout
    env.otelLogsBatchTimeout = maybeInt(OTEL_BSP_SCHEDULE_DELAY)
    env.otelLogsMaxExportBatchSize = maybeInt(OTEL_BSP_MAX_EXPORT_BATCH_SIZE)
    this.#setBoolean(
      env,
      'apmTracingEnabled',
      DD_APM_TRACING_ENABLED ??
        (DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED && isFalse(DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED))
    )
    this.#setBoolean(env, 'appsec.apiSecurity.enabled', DD_API_SECURITY_ENABLED && isTrue(DD_API_SECURITY_ENABLED))
    env['appsec.apiSecurity.sampleDelay'] = maybeFloat(DD_API_SECURITY_SAMPLE_DELAY)
    this.#setBoolean(env, 'appsec.apiSecurity.endpointCollectionEnabled',
      DD_API_SECURITY_ENDPOINT_COLLECTION_ENABLED)
    env['appsec.apiSecurity.endpointCollectionMessageLimit'] =
      maybeInt(DD_API_SECURITY_ENDPOINT_COLLECTION_MESSAGE_LIMIT)
    env['appsec.blockedTemplateGraphql'] = maybeFile(DD_APPSEC_GRAPHQL_BLOCKED_TEMPLATE_JSON)
    env['appsec.blockedTemplateHtml'] = maybeFile(DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML)
    this.#envUnprocessed['appsec.blockedTemplateHtml'] = DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML
    env['appsec.blockedTemplateJson'] = maybeFile(DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON)
    this.#envUnprocessed['appsec.blockedTemplateJson'] = DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON
    this.#setBoolean(env, 'appsec.enabled', DD_APPSEC_ENABLED)
    this.#setString(env, 'appsec.eventTracking.mode', DD_APPSEC_AUTO_USER_INSTRUMENTATION_MODE)
    // TODO appsec.extendedHeadersCollection are deprecated, to delete in a major
    this.#setBoolean(env, 'appsec.extendedHeadersCollection.enabled', DD_APPSEC_COLLECT_ALL_HEADERS)
    this.#setBoolean(
      env,
      'appsec.extendedHeadersCollection.redaction',
      DD_APPSEC_HEADER_COLLECTION_REDACTION_ENABLED
    )
    env['appsec.extendedHeadersCollection.maxHeaders'] = maybeInt(DD_APPSEC_MAX_COLLECTED_HEADERS)
    this.#envUnprocessed['appsec.extendedHeadersCollection.maxHeaders'] = DD_APPSEC_MAX_COLLECTED_HEADERS
    this.#setString(env, 'appsec.obfuscatorKeyRegex', DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP)
    this.#setString(env, 'appsec.obfuscatorValueRegex', DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP)
    this.#setBoolean(env, 'appsec.rasp.enabled', DD_APPSEC_RASP_ENABLED)
    // TODO Deprecated, to delete in a major
    this.#setBoolean(env, 'appsec.rasp.bodyCollection', DD_APPSEC_RASP_COLLECT_REQUEST_BODY)
    env['appsec.rateLimit'] = maybeInt(DD_APPSEC_TRACE_RATE_LIMIT)
    this.#envUnprocessed['appsec.rateLimit'] = DD_APPSEC_TRACE_RATE_LIMIT
    this.#setString(env, 'appsec.rules', DD_APPSEC_RULES)
    // DD_APPSEC_SCA_ENABLED is never used locally, but only sent to the backend
    this.#setBoolean(env, 'appsec.sca.enabled', DD_APPSEC_SCA_ENABLED)
    this.#setBoolean(env, 'appsec.stackTrace.enabled', DD_APPSEC_STACK_TRACE_ENABLED)
    env['appsec.stackTrace.maxDepth'] = maybeInt(DD_APPSEC_MAX_STACK_TRACE_DEPTH)
    this.#envUnprocessed['appsec.stackTrace.maxDepth'] = DD_APPSEC_MAX_STACK_TRACE_DEPTH
    env['appsec.stackTrace.maxStackTraces'] = maybeInt(DD_APPSEC_MAX_STACK_TRACES)
    this.#envUnprocessed['appsec.stackTrace.maxStackTraces'] = DD_APPSEC_MAX_STACK_TRACES
    env['appsec.wafTimeout'] = maybeInt(DD_APPSEC_WAF_TIMEOUT)
    this.#envUnprocessed['appsec.wafTimeout'] = DD_APPSEC_WAF_TIMEOUT
    env.baggageMaxBytes = DD_TRACE_BAGGAGE_MAX_BYTES
    env.baggageMaxItems = DD_TRACE_BAGGAGE_MAX_ITEMS
    env.baggageTagKeys = DD_TRACE_BAGGAGE_TAG_KEYS
    this.#setBoolean(env, 'clientIpEnabled', DD_TRACE_CLIENT_IP_ENABLED)
    this.#setString(env, 'clientIpHeader', DD_TRACE_CLIENT_IP_HEADER?.toLowerCase())
    this.#setBoolean(env, 'crashtracking.enabled', DD_CRASHTRACKING_ENABLED ?? !this._isInServerlessEnvironment())
    this.#setBoolean(env, 'codeOriginForSpans.enabled', DD_CODE_ORIGIN_FOR_SPANS_ENABLED)
    this.#setBoolean(
      env,
      'codeOriginForSpans.experimental.exit_spans.enabled',
      DD_CODE_ORIGIN_FOR_SPANS_EXPERIMENTAL_EXIT_SPANS_ENABLED
    )
    this.#setString(env, 'dbmPropagationMode', DD_DBM_PROPAGATION_MODE)
    this.#setString(env, 'dogstatsd.hostname', DD_DOGSTATSD_HOST)
    this.#setString(env, 'dogstatsd.port', DD_DOGSTATSD_PORT)
    this.#setBoolean(env, 'dsmEnabled', DD_DATA_STREAMS_ENABLED)
    this.#setBoolean(env, 'dynamicInstrumentation.enabled', DD_DYNAMIC_INSTRUMENTATION_ENABLED)
    this.#setString(env, 'dynamicInstrumentation.probeFile', DD_DYNAMIC_INSTRUMENTATION_PROBE_FILE)
    this.#setArray(env, 'dynamicInstrumentation.redactedIdentifiers', DD_DYNAMIC_INSTRUMENTATION_REDACTED_IDENTIFIERS)
    this.#setArray(
      env,
      'dynamicInstrumentation.redactionExcludedIdentifiers',
      DD_DYNAMIC_INSTRUMENTATION_REDACTION_EXCLUDED_IDENTIFIERS
    )
    env['dynamicInstrumentation.uploadIntervalSeconds'] = maybeFloat(DD_DYNAMIC_INSTRUMENTATION_UPLOAD_INTERVAL_SECONDS)
    this.#envUnprocessed['dynamicInstrumentation.uploadInterval'] = DD_DYNAMIC_INSTRUMENTATION_UPLOAD_INTERVAL_SECONDS
    this.#setString(env, 'env', DD_ENV || tags.env)
    this.#setBoolean(env, 'experimental.flaggingProvider.enabled', DD_EXPERIMENTAL_FLAGGING_PROVIDER_ENABLED)
    this.#setBoolean(env, 'traceEnabled', DD_TRACE_ENABLED)
    this.#setBoolean(env, 'experimental.aiguard.enabled', DD_AI_GUARD_ENABLED)
    this.#setString(env, 'experimental.aiguard.endpoint', DD_AI_GUARD_ENDPOINT)
    env['experimental.aiguard.maxContentSize'] = maybeInt(DD_AI_GUARD_MAX_CONTENT_SIZE)
    this.#envUnprocessed['experimental.aiguard.maxContentSize'] = DD_AI_GUARD_MAX_CONTENT_SIZE
    env['experimental.aiguard.maxMessagesLength'] = maybeInt(DD_AI_GUARD_MAX_MESSAGES_LENGTH)
    this.#envUnprocessed['experimental.aiguard.maxMessagesLength'] = DD_AI_GUARD_MAX_MESSAGES_LENGTH
    env['experimental.aiguard.timeout'] = maybeInt(DD_AI_GUARD_TIMEOUT)
    this.#envUnprocessed['experimental.aiguard.timeout'] = DD_AI_GUARD_TIMEOUT
    this.#setBoolean(env, 'experimental.enableGetRumData', DD_TRACE_EXPERIMENTAL_GET_RUM_DATA_ENABLED)
    this.#setString(env, 'experimental.exporter', DD_TRACE_EXPERIMENTAL_EXPORTER)
    env.flushInterval = AWS_LAMBDA_FUNCTION_NAME ? 0 : maybeInt(DD_TRACE_FLUSH_INTERVAL)
    env.flushMinSpans = maybeInt(DD_TRACE_PARTIAL_FLUSH_MIN_SPANS)
    this.#envUnprocessed.flushMinSpans = DD_TRACE_PARTIAL_FLUSH_MIN_SPANS
    this.#setBoolean(env, 'gitMetadataEnabled', DD_TRACE_GIT_METADATA_ENABLED)
    this.#setIntegerRangeSet(env, 'grpc.client.error.statuses', DD_GRPC_CLIENT_ERROR_STATUSES)
    this.#setIntegerRangeSet(env, 'grpc.server.error.statuses', DD_GRPC_SERVER_ERROR_STATUSES)
    this.#setArray(env, 'headerTags', DD_TRACE_HEADER_TAGS)
    env['heapSnapshot.count'] = maybeInt(DD_HEAP_SNAPSHOT_COUNT)
    this.#setString(env, 'heapSnapshot.destination', DD_HEAP_SNAPSHOT_DESTINATION)
    env['heapSnapshot.interval'] = maybeInt(DD_HEAP_SNAPSHOT_INTERVAL)
    this.#setString(env, 'hostname', DD_AGENT_HOST)
    env['iast.dbRowsToTaint'] = maybeInt(DD_IAST_DB_ROWS_TO_TAINT)
    this.#setBoolean(env, 'iast.deduplicationEnabled', DD_IAST_DEDUPLICATION_ENABLED)
    this.#setBoolean(env, 'iast.enabled', DD_IAST_ENABLED)
    env['iast.maxConcurrentRequests'] = maybeInt(DD_IAST_MAX_CONCURRENT_REQUESTS)
    this.#envUnprocessed['iast.maxConcurrentRequests'] = DD_IAST_MAX_CONCURRENT_REQUESTS
    env['iast.maxContextOperations'] = maybeInt(DD_IAST_MAX_CONTEXT_OPERATIONS)
    this.#envUnprocessed['iast.maxContextOperations'] = DD_IAST_MAX_CONTEXT_OPERATIONS
    this.#setBoolean(env, 'iast.redactionEnabled', DD_IAST_REDACTION_ENABLED && !isFalse(DD_IAST_REDACTION_ENABLED))
    this.#setString(env, 'iast.redactionNamePattern', DD_IAST_REDACTION_NAME_PATTERN)
    this.#setString(env, 'iast.redactionValuePattern', DD_IAST_REDACTION_VALUE_PATTERN)
    const iastRequestSampling = maybeInt(DD_IAST_REQUEST_SAMPLING)
    if (iastRequestSampling !== undefined && iastRequestSampling > -1 && iastRequestSampling < 101) {
      env['iast.requestSampling'] = iastRequestSampling
    }
    this.#envUnprocessed['iast.requestSampling'] = DD_IAST_REQUEST_SAMPLING
    this.#setString(env, 'iast.securityControlsConfiguration', DD_IAST_SECURITY_CONTROLS_CONFIGURATION)
    this.#setString(env, 'iast.telemetryVerbosity', DD_IAST_TELEMETRY_VERBOSITY)
    this.#setBoolean(env, 'iast.stackTrace.enabled', DD_IAST_STACK_TRACE_ENABLED)
    this.#setArray(env, 'injectionEnabled', DD_INJECTION_ENABLED)
    this.#setString(env, 'instrumentationSource', DD_INJECTION_ENABLED ? 'ssi' : 'manual')
    this.#setBoolean(env, 'injectForce', DD_INJECT_FORCE)
    this.#setBoolean(env, 'isAzureFunction', getIsAzureFunction())
    this.#setBoolean(env, 'isGCPFunction', getIsGCPFunction())
    env['langchain.spanCharLimit'] = maybeInt(DD_LANGCHAIN_SPAN_CHAR_LIMIT)
    env['langchain.spanPromptCompletionSampleRate'] = maybeFloat(DD_LANGCHAIN_SPAN_PROMPT_COMPLETION_SAMPLE_RATE)
    this.#setBoolean(env, 'legacyBaggageEnabled', DD_TRACE_LEGACY_BAGGAGE_ENABLED)
    this.#setBoolean(env, 'llmobs.agentlessEnabled', DD_LLMOBS_AGENTLESS_ENABLED)
    this.#setBoolean(env, 'llmobs.enabled', DD_LLMOBS_ENABLED)
    this.#setString(env, 'llmobs.mlApp', DD_LLMOBS_ML_APP)
    this.#setBoolean(env, 'logInjection', DD_LOGS_INJECTION)
    // Requires an accompanying DD_APM_OBFUSCATION_MEMCACHED_KEEP_COMMAND=true in the agent
    this.#setBoolean(env, 'memcachedCommandEnabled', DD_TRACE_MEMCACHED_COMMAND_ENABLED)
    this.#setBoolean(env, 'middlewareTracingEnabled', DD_TRACE_MIDDLEWARE_TRACING_ENABLED)
    this.#setBoolean(env, 'openAiLogsEnabled', DD_OPENAI_LOGS_ENABLED)
    env['openai.spanCharLimit'] = maybeInt(DD_OPENAI_SPAN_CHAR_LIMIT)
    this.#envUnprocessed.openaiSpanCharLimit = DD_OPENAI_SPAN_CHAR_LIMIT
    if (DD_TRACE_PEER_SERVICE_MAPPING) {
      env.peerServiceMapping = Object.fromEntries(
        DD_TRACE_PEER_SERVICE_MAPPING.split(',').map(x => x.trim().split(':'))
      )
      this.#envUnprocessed.peerServiceMapping = DD_TRACE_PEER_SERVICE_MAPPING
    }
    this.#setString(env, 'port', DD_TRACE_AGENT_PORT)
    const profilingEnabled = normalizeProfilingEnabledValue(
      DD_PROFILING_ENABLED ??
      (this._isInServerlessEnvironment() ? 'false' : undefined)
    )
    this.#setString(env, 'profiling.enabled', profilingEnabled)
    this.#setString(env, 'profiling.exporters', DD_PROFILING_EXPORTERS)
    this.#setBoolean(env, 'profiling.sourceMap', DD_PROFILING_SOURCE_MAP && !isFalse(DD_PROFILING_SOURCE_MAP))
    if (DD_INTERNAL_PROFILING_LONG_LIVED_THRESHOLD) {
      // This is only used in testing to not have to wait 30s
      env['profiling.longLivedThreshold'] = Number(DD_INTERNAL_PROFILING_LONG_LIVED_THRESHOLD)
    }

    this.#setString(env, 'protocolVersion', DD_TRACE_AGENT_PROTOCOL_VERSION)
    this.#setString(env, 'queryStringObfuscation', DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP)
    this.#setBoolean(env, 'remoteConfig.enabled', DD_REMOTE_CONFIGURATION_ENABLED ?? !this._isInServerlessEnvironment())
    env['remoteConfig.pollInterval'] = maybeFloat(DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS)
    this.#envUnprocessed['remoteConfig.pollInterval'] = DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS
    this.#setBoolean(env, 'reportHostname', DD_TRACE_REPORT_HOSTNAME)
    // only used to explicitly set runtimeMetrics to false
    const otelSetRuntimeMetrics = String(OTEL_METRICS_EXPORTER).toLowerCase() === 'none'
      ? false
      : undefined
    this.#setBoolean(env, 'runtimeMetrics.enabled', DD_RUNTIME_METRICS_ENABLED ||
    otelSetRuntimeMetrics)
    this.#setBoolean(env, 'runtimeMetrics.eventLoop', DD_RUNTIME_METRICS_EVENT_LOOP_ENABLED)
    this.#setBoolean(env, 'runtimeMetrics.gc', DD_RUNTIME_METRICS_GC_ENABLED)
    this.#setBoolean(env, 'runtimeMetricsRuntimeId', DD_RUNTIME_METRICS_RUNTIME_ID_ENABLED)
    this.#setArray(env, 'sampler.spanSamplingRules', reformatSpanSamplingRules(
      maybeJsonFile(DD_SPAN_SAMPLING_RULES_FILE) ??
      safeJsonParse(DD_SPAN_SAMPLING_RULES)
    ))
    this.#setUnit(env, 'sampleRate', DD_TRACE_SAMPLE_RATE ||
    getFromOtelSamplerMap(OTEL_TRACES_SAMPLER, OTEL_TRACES_SAMPLER_ARG))
    env['sampler.rateLimit'] = DD_TRACE_RATE_LIMIT
    this.#setSamplingRule(env, 'sampler.rules', safeJsonParse(DD_TRACE_SAMPLING_RULES))
    this.#envUnprocessed['sampler.rules'] = DD_TRACE_SAMPLING_RULES
    this.#setString(env, 'scope', DD_TRACE_SCOPE)
    this.#setString(env, 'service', DD_SERVICE || tags.service || OTEL_SERVICE_NAME)
    if (DD_SERVICE_MAPPING) {
      env.serviceMapping = Object.fromEntries(
        DD_SERVICE_MAPPING.split(',').map(x => x.trim().split(':'))
      )
    }
    this.#setString(env, 'site', DD_SITE)
    if (DD_TRACE_SPAN_ATTRIBUTE_SCHEMA) {
      this.#setString(env, 'spanAttributeSchema', validateNamingVersion(DD_TRACE_SPAN_ATTRIBUTE_SCHEMA))
      this.#envUnprocessed.spanAttributeSchema = DD_TRACE_SPAN_ATTRIBUTE_SCHEMA
    }
    // 0: disabled, 1: logging, 2: garbage collection + logging
    env.spanLeakDebug = maybeInt(DD_TRACE_SPAN_LEAK_DEBUG)
    this.#setBoolean(env, 'spanRemoveIntegrationFromService', DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED)
    this.#setBoolean(env, 'startupLogs', DD_TRACE_STARTUP_LOGS)
    this.#setTags(env, 'tags', tags)
    env.tagsHeaderMaxLength = DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH
    this.#setBoolean(env, 'telemetry.enabled', DD_INSTRUMENTATION_TELEMETRY_ENABLED ??
      !(this._isInServerlessEnvironment() || JEST_WORKER_ID))
    this.#setString(env, 'instrumentation_config_id', DD_INSTRUMENTATION_CONFIG_ID)
    this.#setBoolean(env, 'telemetry.debug', DD_TELEMETRY_DEBUG)
    this.#setBoolean(env, 'telemetry.dependencyCollection', DD_TELEMETRY_DEPENDENCY_COLLECTION_ENABLED)
    env['telemetry.heartbeatInterval'] = maybeInt(Math.floor(DD_TELEMETRY_HEARTBEAT_INTERVAL * 1000))
    this.#envUnprocessed['telemetry.heartbeatInterval'] = DD_TELEMETRY_HEARTBEAT_INTERVAL * 1000
    this.#setBoolean(env, 'telemetry.logCollection', DD_TELEMETRY_LOG_COLLECTION_ENABLED)
    this.#setBoolean(env, 'telemetry.metrics', DD_TELEMETRY_METRICS_ENABLED)
    this.#setBoolean(env, 'traceId128BitGenerationEnabled', DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED)
    this.#setBoolean(env, 'traceId128BitLoggingEnabled', DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED)
    this.#setBoolean(env, 'tracePropagationExtractFirst', DD_TRACE_PROPAGATION_EXTRACT_FIRST)
    const stringPropagationBehaviorExtract = String(DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT)
    env.tracePropagationBehaviorExtract =
      VALID_PROPAGATION_BEHAVIOR_EXTRACT.has(stringPropagationBehaviorExtract)
        ? stringPropagationBehaviorExtract
        : 'continue'
    this.#setBoolean(env, 'tracePropagationStyle.otelPropagators',
      DD_TRACE_PROPAGATION_STYLE ||
      DD_TRACE_PROPAGATION_STYLE_INJECT ||
      DD_TRACE_PROPAGATION_STYLE_EXTRACT
        ? false
        : !!OTEL_PROPAGATORS)
    this.#setBoolean(env, 'traceWebsocketMessagesEnabled', DD_TRACE_WEBSOCKET_MESSAGES_ENABLED)
    this.#setBoolean(env, 'traceWebsocketMessagesInheritSampling', DD_TRACE_WEBSOCKET_MESSAGES_INHERIT_SAMPLING)
    this.#setBoolean(env, 'traceWebsocketMessagesSeparateTraces', DD_TRACE_WEBSOCKET_MESSAGES_SEPARATE_TRACES)
    this.#setBoolean(env, 'tracing', DD_TRACING_ENABLED)
    this.#setString(env, 'version', DD_VERSION || tags.version)
    this.#setBoolean(env, 'inferredProxyServicesEnabled', DD_TRACE_INFERRED_PROXY_SERVICES_ENABLED)
    this.#setBoolean(env, 'trace.aws.addSpanPointers', DD_TRACE_AWS_ADD_SPAN_POINTERS)
    this.#setString(env, 'trace.dynamoDb.tablePrimaryKeys', DD_TRACE_DYNAMODB_TABLE_PRIMARY_KEYS)
    this.#setArray(env, 'graphqlErrorExtensions', DD_TRACE_GRAPHQL_ERROR_EXTENSIONS)
    this.#setBoolean(env, 'trace.nativeSpanEvents', DD_TRACE_NATIVE_SPAN_EVENTS)
    env['vertexai.spanPromptCompletionSampleRate'] = maybeFloat(DD_VERTEXAI_SPAN_PROMPT_COMPLETION_SAMPLE_RATE)
    env['vertexai.spanCharLimit'] = maybeInt(DD_VERTEXAI_SPAN_CHAR_LIMIT)
  }

  #applyOptions (options) {
    const opts = this.#options
    const tags = {}

    options = this.#optionsArg = { ingestion: {}, ...options, ...opts }

    tagger.add(tags, options.tags)

    this.#setBoolean(opts, 'apmTracingEnabled', options.apmTracingEnabled ??
      (options.experimental?.appsec?.standalone && !options.experimental.appsec.standalone.enabled)
    )
    this.#setBoolean(opts, 'appsec.apiSecurity.enabled', options.appsec?.apiSecurity?.enabled)
    this.#setBoolean(opts, 'appsec.apiSecurity.endpointCollectionEnabled',
      options.appsec?.apiSecurity?.endpointCollectionEnabled)
    opts['appsec.apiSecurity.endpointCollectionMessageLimit'] =
      maybeInt(options.appsec?.apiSecurity?.endpointCollectionMessageLimit)
    opts['appsec.blockedTemplateGraphql'] = maybeFile(options.appsec?.blockedTemplateGraphql)
    opts['appsec.blockedTemplateHtml'] = maybeFile(options.appsec?.blockedTemplateHtml)
    this.#optsUnprocessed['appsec.blockedTemplateHtml'] = options.appsec?.blockedTemplateHtml
    opts['appsec.blockedTemplateJson'] = maybeFile(options.appsec?.blockedTemplateJson)
    this.#optsUnprocessed['appsec.blockedTemplateJson'] = options.appsec?.blockedTemplateJson
    this.#setBoolean(opts, 'appsec.enabled', options.appsec?.enabled)
    this.#setString(opts, 'appsec.eventTracking.mode', options.appsec?.eventTracking?.mode)
    this.#setBoolean(
      opts,
      'appsec.extendedHeadersCollection.enabled',
      options.appsec?.extendedHeadersCollection?.enabled
    )
    this.#setBoolean(
      opts,
      'appsec.extendedHeadersCollection.redaction',
      options.appsec?.extendedHeadersCollection?.redaction
    )
    opts['appsec.extendedHeadersCollection.maxHeaders'] = options.appsec?.extendedHeadersCollection?.maxHeaders
    this.#setString(opts, 'appsec.obfuscatorKeyRegex', options.appsec?.obfuscatorKeyRegex)
    this.#setString(opts, 'appsec.obfuscatorValueRegex', options.appsec?.obfuscatorValueRegex)
    this.#setBoolean(opts, 'appsec.rasp.enabled', options.appsec?.rasp?.enabled)
    this.#setBoolean(opts, 'appsec.rasp.bodyCollection', options.appsec?.rasp?.bodyCollection)
    opts['appsec.rateLimit'] = maybeInt(options.appsec?.rateLimit)
    this.#optsUnprocessed['appsec.rateLimit'] = options.appsec?.rateLimit
    this.#setString(opts, 'appsec.rules', options.appsec?.rules)
    this.#setBoolean(opts, 'appsec.stackTrace.enabled', options.appsec?.stackTrace?.enabled)
    opts['appsec.stackTrace.maxDepth'] = maybeInt(options.appsec?.stackTrace?.maxDepth)
    this.#optsUnprocessed['appsec.stackTrace.maxDepth'] = options.appsec?.stackTrace?.maxDepth
    opts['appsec.stackTrace.maxStackTraces'] = maybeInt(options.appsec?.stackTrace?.maxStackTraces)
    this.#optsUnprocessed['appsec.stackTrace.maxStackTraces'] = options.appsec?.stackTrace?.maxStackTraces
    opts['appsec.wafTimeout'] = maybeInt(options.appsec?.wafTimeout)
    this.#optsUnprocessed['appsec.wafTimeout'] = options.appsec?.wafTimeout
    this.#setBoolean(opts, 'clientIpEnabled', options.clientIpEnabled)
    this.#setString(opts, 'clientIpHeader', options.clientIpHeader?.toLowerCase())
    opts.baggageMaxBytes = options.baggageMaxBytes
    opts.baggageMaxItems = options.baggageMaxItems
    opts.baggageTagKeys = options.baggageTagKeys
    this.#setBoolean(opts, 'codeOriginForSpans.enabled', options.codeOriginForSpans?.enabled)
    this.#setBoolean(
      opts,
      'codeOriginForSpans.experimental.exit_spans.enabled',
      options.codeOriginForSpans?.experimental?.exit_spans?.enabled
    )
    this.#setString(opts, 'dbmPropagationMode', options.dbmPropagationMode)
    if (options.dogstatsd) {
      this.#setString(opts, 'dogstatsd.hostname', options.dogstatsd.hostname)
      this.#setString(opts, 'dogstatsd.port', options.dogstatsd.port)
    }
    this.#setBoolean(opts, 'dsmEnabled', options.dsmEnabled)
    this.#setBoolean(opts, 'dynamicInstrumentation.enabled', options.dynamicInstrumentation?.enabled)
    this.#setString(opts, 'dynamicInstrumentation.probeFile', options.dynamicInstrumentation?.probeFile)
    this.#setArray(
      opts,
      'dynamicInstrumentation.redactedIdentifiers',
      options.dynamicInstrumentation?.redactedIdentifiers
    )
    this.#setArray(
      opts,
      'dynamicInstrumentation.redactionExcludedIdentifiers',
      options.dynamicInstrumentation?.redactionExcludedIdentifiers
    )
    opts['dynamicInstrumentation.uploadIntervalSeconds'] =
      maybeFloat(options.dynamicInstrumentation?.uploadIntervalSeconds)
    this.#optsUnprocessed['dynamicInstrumentation.uploadIntervalSeconds'] =
      options.dynamicInstrumentation?.uploadIntervalSeconds
    this.#setString(opts, 'env', options.env || tags.env)
    this.#setBoolean(opts, 'experimental.aiguard.enabled', options.experimental?.aiguard?.enabled)
    this.#setString(opts, 'experimental.aiguard.endpoint', options.experimental?.aiguard?.endpoint)
    opts['experimental.aiguard.maxMessagesLength'] = maybeInt(options.experimental?.aiguard?.maxMessagesLength)
    this.#optsUnprocessed['experimental.aiguard.maxMessagesLength'] = options.experimental?.aiguard?.maxMessagesLength
    opts['experimental.aiguard.maxContentSize'] = maybeInt(options.experimental?.aiguard?.maxContentSize)
    this.#optsUnprocessed['experimental.aiguard.maxContentSize'] = options.experimental?.aiguard?.maxContentSize
    opts['experimental.aiguard.timeout'] = maybeInt(options.experimental?.aiguard?.timeout)
    this.#optsUnprocessed['experimental.aiguard.timeout'] = options.experimental?.aiguard?.timeout
    this.#setBoolean(opts, 'experimental.enableGetRumData', options.experimental?.enableGetRumData)
    this.#setString(opts, 'experimental.exporter', options.experimental?.exporter)
    this.#setBoolean(opts, 'experimental.flaggingProvider.enabled', options.experimental?.flaggingProvider?.enabled)
    opts.flushInterval = maybeInt(options.flushInterval)
    this.#optsUnprocessed.flushInterval = options.flushInterval
    opts.flushMinSpans = maybeInt(options.flushMinSpans)
    this.#optsUnprocessed.flushMinSpans = options.flushMinSpans
    this.#setArray(opts, 'headerTags', options.headerTags)
    this.#setString(opts, 'hostname', options.hostname)
    opts['iast.dbRowsToTaint'] = maybeInt(options.iast?.dbRowsToTaint)
    this.#setBoolean(opts, 'iast.deduplicationEnabled', options.iast && options.iast.deduplicationEnabled)
    this.#setBoolean(opts, 'iast.enabled',
      options.iast && (options.iast === true || options.iast.enabled === true))
    opts['iast.maxConcurrentRequests'] = maybeInt(options.iast?.maxConcurrentRequests)
    this.#optsUnprocessed['iast.maxConcurrentRequests'] = options.iast?.maxConcurrentRequests
    opts['iast.maxContextOperations'] = maybeInt(options.iast?.maxContextOperations)
    this.#optsUnprocessed['iast.maxContextOperations'] = options.iast?.maxContextOperations
    this.#setBoolean(opts, 'iast.redactionEnabled', options.iast?.redactionEnabled)
    this.#setString(opts, 'iast.redactionNamePattern', options.iast?.redactionNamePattern)
    this.#setString(opts, 'iast.redactionValuePattern', options.iast?.redactionValuePattern)
    const iastRequestSampling = maybeInt(options.iast?.requestSampling)
    if (iastRequestSampling !== undefined && iastRequestSampling > -1 && iastRequestSampling < 101) {
      opts['iast.requestSampling'] = iastRequestSampling
      this.#optsUnprocessed['iast.requestSampling'] = options.iast?.requestSampling
    }
    opts['iast.securityControlsConfiguration'] = options.iast?.securityControlsConfiguration
    this.#setBoolean(opts, 'iast.stackTrace.enabled', options.iast?.stackTrace?.enabled)
    this.#setString(opts, 'iast.telemetryVerbosity', options.iast && options.iast.telemetryVerbosity)
    this.#setBoolean(opts, 'isCiVisibility', options.isCiVisibility)
    this.#setBoolean(opts, 'legacyBaggageEnabled', options.legacyBaggageEnabled)
    this.#setBoolean(opts, 'llmobs.agentlessEnabled', options.llmobs?.agentlessEnabled)
    this.#setString(opts, 'llmobs.mlApp', options.llmobs?.mlApp)
    this.#setBoolean(opts, 'logInjection', options.logInjection)
    opts.lookup = options.lookup
    this.#setBoolean(opts, 'middlewareTracingEnabled', options.middlewareTracingEnabled)
    this.#setBoolean(opts, 'openAiLogsEnabled', options.openAiLogsEnabled)
    opts.peerServiceMapping = options.peerServiceMapping
    this.#setBoolean(opts, 'plugins', options.plugins)
    this.#setString(opts, 'port', options.port)
    const strProfiling = String(options.profiling)
    if (['true', 'false', 'auto'].includes(strProfiling)) {
      this.#setString(opts, 'profiling.enabled', strProfiling)
    }
    this.#setString(opts, 'protocolVersion', options.protocolVersion)
    if (options.remoteConfig) {
      opts['remoteConfig.pollInterval'] = maybeFloat(options.remoteConfig.pollInterval)
      this.#optsUnprocessed['remoteConfig.pollInterval'] = options.remoteConfig.pollInterval
    }
    this.#setBoolean(opts, 'reportHostname', options.reportHostname)
    this.#setBoolean(opts, 'runtimeMetrics.enabled', options.runtimeMetrics?.enabled)
    this.#setBoolean(opts, 'runtimeMetrics.eventLoop', options.runtimeMetrics?.eventLoop)
    this.#setBoolean(opts, 'runtimeMetrics.gc', options.runtimeMetrics?.gc)
    this.#setBoolean(opts, 'runtimeMetricsRuntimeId', options.runtimeMetricsRuntimeId)
    this.#setArray(opts, 'sampler.spanSamplingRules', reformatSpanSamplingRules(options.spanSamplingRules))
    this.#setUnit(opts, 'sampleRate', options.sampleRate ?? options.ingestion.sampleRate)
    opts['sampler.rateLimit'] = maybeInt(options.rateLimit ?? options.ingestion.rateLimit)
    this.#setSamplingRule(opts, 'sampler.rules', options.samplingRules)
    this.#setString(opts, 'service', options.service || tags.service)
    opts.serviceMapping = options.serviceMapping
    this.#setString(opts, 'site', options.site)
    if (options.spanAttributeSchema) {
      this.#setString(opts, 'spanAttributeSchema', validateNamingVersion(options.spanAttributeSchema))
      this.#optsUnprocessed.spanAttributeSchema = options.spanAttributeSchema
    }
    this.#setBoolean(opts, 'spanRemoveIntegrationFromService', options.spanRemoveIntegrationFromService)
    this.#setBoolean(opts, 'startupLogs', options.startupLogs)
    this.#setTags(opts, 'tags', tags)
    this.#setBoolean(opts, 'traceId128BitGenerationEnabled', options.traceId128BitGenerationEnabled)
    this.#setBoolean(opts, 'traceId128BitLoggingEnabled', options.traceId128BitLoggingEnabled)
    this.#setBoolean(opts, 'traceWebsocketMessagesEnabled', options.traceWebsocketMessagesEnabled)
    this.#setBoolean(opts, 'traceWebsocketMessagesInheritSampling', options.traceWebsocketMessagesInheritSampling)
    this.#setBoolean(opts, 'traceWebsocketMessagesSeparateTraces', options.traceWebsocketMessagesSeparateTraces)
    this.#setString(opts, 'version', options.version || tags.version)
    this.#setBoolean(opts, 'inferredProxyServicesEnabled', options.inferredProxyServicesEnabled)
    this.#setBoolean(opts, 'graphqlErrorExtensions', options.graphqlErrorExtensions)
    this.#setBoolean(opts, 'trace.nativeSpanEvents', options.trace?.nativeSpanEvents)

    // For LLMObs, we want the environment variable to take precedence over the options.
    // This is reliant on environment config being set before options.
    // This is to make sure the origins of each value are tracked appropriately for telemetry.
    // We'll only set `llmobs.enabled` on the opts when it's not set on the environment, and options.llmobs is provided.
    const llmobsEnabledEnv = this.#env['llmobs.enabled']
    if (llmobsEnabledEnv == null && options.llmobs) {
      this.#setBoolean(opts, 'llmobs.enabled', !!options.llmobs)
    }
  }

  #isCiVisibility () {
    return this.#optionsArg.isCiVisibility ?? this.#defaults.isCiVisibility
  }

  #isCiVisibilityItrEnabled () {
    return getEnv('DD_CIVISIBILITY_ITR_ENABLED') ?? true
  }

  #getHostname () {
    const DD_CIVISIBILITY_AGENTLESS_URL = getEnv('DD_CIVISIBILITY_AGENTLESS_URL')
    const url = DD_CIVISIBILITY_AGENTLESS_URL
      ? new URL(DD_CIVISIBILITY_AGENTLESS_URL)
      : getAgentUrl(this._getTraceAgentUrl(), this.#optionsArg)
    const DD_AGENT_HOST = this.#optionsArg.hostname ??
      getEnv('DD_AGENT_HOST') ??
      defaults.hostname
    return DD_AGENT_HOST || url?.hostname
  }

  #getSpanComputePeerService () {
    const DD_TRACE_SPAN_ATTRIBUTE_SCHEMA = validateNamingVersion(
      this.#optionsArg.spanAttributeSchema ??
      getEnv('DD_TRACE_SPAN_ATTRIBUTE_SCHEMA')
    )

    const peerServiceSet = (
      this.#optionsArg.hasOwnProperty('spanComputePeerService') ||
      getEnv('DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED') !== undefined
    )
    const peerServiceValue = this.#optionsArg.spanComputePeerService ??
      getEnv('DD_TRACE_PEER_SERVICE_DEFAULTS_ENABLED')

    const spanComputePeerService = (
      DD_TRACE_SPAN_ATTRIBUTE_SCHEMA === 'v0'
        // In v0, peer service is computed only if it is explicitly set to true
        ? peerServiceSet && isTrue(peerServiceValue)
        // In >v0, peer service is false only if it is explicitly set to false
        : (peerServiceSet ? !isFalse(peerServiceValue) : true)
    )

    return spanComputePeerService
  }

  #isTraceStatsComputationEnabled () {
    const apmTracingEnabled = this.#options.apmTracingEnabled !== false &&
      this.#env.apmTracingEnabled !== false

    return apmTracingEnabled && (
      this.#optionsArg.stats ??
      getEnv('DD_TRACE_STATS_COMPUTATION_ENABLED') ??
      (getIsGCPFunction() || getIsAzureFunction())
    )
  }

  _getTraceAgentUrl () {
    return this.#optionsArg.url ??
      getEnv('DD_TRACE_AGENT_URL') ??
      null
  }

  // handles values calculated from a mixture of options and env vars
  #applyCalculated () {
    const calc = this.#calculated

    const DD_CIVISIBILITY_AGENTLESS_URL = getEnv('DD_CIVISIBILITY_AGENTLESS_URL')

    calc.url = DD_CIVISIBILITY_AGENTLESS_URL
      ? new URL(DD_CIVISIBILITY_AGENTLESS_URL)
      : getAgentUrl(this._getTraceAgentUrl(), this.#optionsArg)

    if (this.#isCiVisibility()) {
      this.#setBoolean(calc, 'isEarlyFlakeDetectionEnabled',
        getEnv('DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED') ?? true)
      this.#setBoolean(calc, 'isFlakyTestRetriesEnabled', getEnv('DD_CIVISIBILITY_FLAKY_RETRY_ENABLED') ?? true)
      calc.flakyTestRetriesCount = maybeInt(getEnv('DD_CIVISIBILITY_FLAKY_RETRY_COUNT')) ?? 5
      this.#setBoolean(calc, 'isIntelligentTestRunnerEnabled', isTrue(this.#isCiVisibilityItrEnabled()))
      this.#setBoolean(calc, 'isManualApiEnabled', !isFalse(getEnv('DD_CIVISIBILITY_MANUAL_API_ENABLED')))
      this.#setString(calc, 'ciVisibilityTestSessionName', getEnv('DD_TEST_SESSION_NAME'))
      this.#setBoolean(calc, 'ciVisAgentlessLogSubmissionEnabled',
        isTrue(getEnv('DD_AGENTLESS_LOG_SUBMISSION_ENABLED')))
      this.#setBoolean(calc, 'isTestDynamicInstrumentationEnabled',
        !isFalse(getEnv('DD_TEST_FAILED_TEST_REPLAY_ENABLED')))
      this.#setBoolean(calc, 'isServiceUserProvided', !!this.#env.service)
      this.#setBoolean(calc, 'isTestManagementEnabled', !isFalse(getEnv('DD_TEST_MANAGEMENT_ENABLED')))
      calc.testManagementAttemptToFixRetries = maybeInt(getEnv('DD_TEST_MANAGEMENT_ATTEMPT_TO_FIX_RETRIES')) ?? 20
      this.#setBoolean(calc, 'isImpactedTestsEnabled',
        !isFalse(getEnv('DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED')))
    }

    // Disable log injection when OTEL logs are enabled
    // OTEL logs and DD log injection are mutually exclusive
    if (this.#env.otelLogsEnabled) {
      this.#setBoolean(calc, 'logInjection', false)
    }

    calc['dogstatsd.hostname'] = this.#getHostname()

    // Compute OTLP logs URL to send payloads to the active Datadog Agent
    const agentHostname = this.#getHostname()
    calc.otelLogsUrl = `http://${agentHostname}:${DEFAULT_OTLP_PORT}`
    calc.otelUrl = `http://${agentHostname}:${DEFAULT_OTLP_PORT}`

    this.#setBoolean(calc, 'isGitUploadEnabled',
      calc.isIntelligentTestRunnerEnabled && !isFalse(getEnv('DD_CIVISIBILITY_GIT_UPLOAD_ENABLED')))

    this.#setBoolean(calc, 'spanComputePeerService', this.#getSpanComputePeerService())
    this.#setBoolean(calc, 'stats.enabled', this.#isTraceStatsComputationEnabled())
    const defaultPropagationStyle = this.#getDefaultPropagationStyle(this.#optionsArg)
    calc['tracePropagationStyle.inject'] = propagationStyle(
      'inject',
      this.#optionsArg.tracePropagationStyle
    )
    calc['tracePropagationStyle.extract'] = propagationStyle(
      'extract',
      this.#optionsArg.tracePropagationStyle
    )
    if (defaultPropagationStyle.length > 2) {
      calc['tracePropagationStyle.inject'] = calc['tracePropagationStyle.inject'] || defaultPropagationStyle
      calc['tracePropagationStyle.extract'] = calc['tracePropagationStyle.extract'] || defaultPropagationStyle
    }
  }

  #applyRemote (options) {
    const opts = this.#remote
    const tags = {}
    const headerTags = options.tracing_header_tags
      ? options.tracing_header_tags.map(tag => {
        return tag.tag_name ? `${tag.header}:${tag.tag_name}` : tag.header
      })
      : undefined

    tagger.add(tags, options.tracing_tags)
    if (Object.keys(tags).length) tags['runtime-id'] = runtimeId

    this.#setUnit(opts, 'sampleRate', options.tracing_sampling_rate)
    this.#setBoolean(opts, 'logInjection', options.log_injection_enabled)
    opts.headerTags = headerTags
    this.#setTags(opts, 'tags', tags)
    this.#setBoolean(opts, 'tracing', options.tracing_enabled)
    this.#remoteUnprocessed['sampler.rules'] = options.tracing_sampling_rules
    this.#setSamplingRule(opts, 'sampler.rules', this.#reformatTags(options.tracing_sampling_rules))
  }

  #reformatTags (samplingRules) {
    for (const rule of (samplingRules || [])) {
      const reformattedTags = {}
      if (rule.tags) {
        for (const tag of rule.tags) {
          reformattedTags[tag.key] = tag.value_glob
        }
        rule.tags = reformattedTags
      }
    }
    return samplingRules
  }

  #setBoolean (obj, name, value) {
    if (value === undefined || value === null) {
      obj[name] = value
    } else if (isTrue(value)) {
      obj[name] = true
    } else if (isFalse(value)) {
      obj[name] = false
    }
  }

  #setUnit (obj, name, value) {
    if (value === null || value === undefined) {
      obj[name] = value
      return
    }

    value = Number.parseFloat(value)

    if (!Number.isNaN(value)) {
      // TODO: Ignore out of range values instead of normalizing them.
      obj[name] = Math.min(Math.max(value, 0), 1)
    }
  }

  #setArray (obj, name, value) {
    if (value == null) {
      obj[name] = null
      return
    }

    if (typeof value === 'string') {
      value = value.split(',').map(item => {
        // Trim each item and remove whitespace around the colon
        const [key, val] = item.split(':').map(part => part.trim())
        return val === undefined ? key : `${key}:${val}`
      })
    }

    if (Array.isArray(value)) {
      obj[name] = value
    }
  }

  #setIntegerRangeSet (obj, name, value) {
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

  #setSamplingRule (obj, name, value) {
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

  #setString (obj, name, value) {
    obj[name] = value ? String(value) : undefined // unset for empty strings
  }

  #setTags (obj, name, value) {
    if (!value || Object.keys(value).length === 0) {
      obj[name] = null
      return
    }

    obj[name] = value
  }

  #setAndTrackChange ({ name, value, origin, unprocessedValue, changes }) {
    set(this, name, value)

    if (!changeTracker[name]) {
      changeTracker[name] = {}
    }

    const originExists = origin in changeTracker[name]
    const oldValue = changeTracker[name][origin]

    if (!originExists || oldValue !== value) {
      changeTracker[name][origin] = value
      changes.push({
        name,
        value: unprocessedValue || value,
        origin
      })
    }
  }

  // TODO: Report origin changes and errors to telemetry.
  // TODO: Deeply merge configurations.
  // TODO: Move change tracking to telemetry.
  // for telemetry reporting, `name`s in `containers` need to be keys from:
  // https://github.com/DataDog/dd-go/blob/prod/trace/apps/tracer-telemetry-intake/telemetry-payload/static/config_norm_rules.json
  #merge () {
    const changes = []
    const sources = this.#getSourcesInOrder()

    for (const name of Object.keys(this.#defaults)) {
      // Use reverse order for merge (lowest priority first)
      for (let i = sources.length - 1; i >= 0; i--) {
        const { container, origin, unprocessed } = sources[i]
        const value = container[name]
        if (value != null || container === this.#defaults) {
          this.#setAndTrackChange({
            name,
            value,
            origin,
            unprocessedValue: unprocessed?.[name],
            changes
          })
        }
      }
    }
    this.sampler.sampleRate = this.sampleRate
    updateConfig(changes, this)
  }

  getOrigin (name) {
    for (const { container, origin } of this.#getSourcesInOrder()) {
      const value = container[name]
      if (value != null || container === this.#defaults) {
        return origin
      }
    }
  }

  #loadGitMetadata (envs) {
    // try to read Git metadata from the environment variables
    this.repositoryUrl = removeUserSensitiveInfo(
      envs.DD_GIT_REPOSITORY_URL ??
      this.tags[GIT_REPOSITORY_URL]
    )
    this.commitSHA = envs.DD_GIT_COMMIT_SHA ??
      this.tags[GIT_COMMIT_SHA]

    // otherwise, try to read Git metadata from the git.properties file
    if (!this.repositoryUrl || !this.commitSHA) {
      const DD_GIT_PROPERTIES_FILE = envs.DD_GIT_PROPERTIES_FILE ??
        `${process.cwd()}/git.properties`
      let gitPropertiesString
      try {
        gitPropertiesString = fs.readFileSync(DD_GIT_PROPERTIES_FILE, 'utf8')
      } catch (e) {
        // Only log error if the user has set a git.properties path
        if (envs.DD_GIT_PROPERTIES_FILE) {
          log.error('Error reading DD_GIT_PROPERTIES_FILE: %s', DD_GIT_PROPERTIES_FILE, e)
        }
      }
      if (gitPropertiesString) {
        const { commitSHA, repositoryUrl } = getGitMetadataFromGitProperties(gitPropertiesString)
        this.commitSHA = this.commitSHA || commitSHA
        this.repositoryUrl = this.repositoryUrl || repositoryUrl
      }
    }
    // otherwise, try to read Git metadata from the .git/ folder
    if (!this.repositoryUrl || !this.commitSHA) {
      const DD_GIT_FOLDER_PATH = envs.DD_GIT_FOLDER_PATH ??
        path.join(process.cwd(), '.git')
      if (!this.repositoryUrl) {
        // try to read git config (repository URL)
        const gitConfigPath = path.join(DD_GIT_FOLDER_PATH, 'config')
        try {
          const gitConfigContent = fs.readFileSync(gitConfigPath, 'utf8')
          if (gitConfigContent) {
            this.repositoryUrl = getRemoteOriginURL(gitConfigContent)
          }
        } catch (e) {
          // Only log error if the user has set a .git/ path
          if (envs.DD_GIT_FOLDER_PATH) {
            log.error('Error reading git config: %s', gitConfigPath, e)
          }
        }
      }
      if (!this.commitSHA) {
        // try to read git HEAD (commit SHA)
        const gitHeadSha = resolveGitHeadSHA(DD_GIT_FOLDER_PATH)
        if (gitHeadSha) {
          this.commitSHA = gitHeadSha
        }
      }
    }
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
    !getEnv('DD_AGENT_HOST') &&
    !getEnv('DD_TRACE_AGENT_PORT') &&
    fs.existsSync('/var/run/datadog/apm.socket')
  ) {
    return new URL('unix:///var/run/datadog/apm.socket')
  }
}

module.exports = Config
