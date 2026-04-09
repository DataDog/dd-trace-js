'use strict'

const fs = require('node:fs')
const os = require('node:os')
const { URL } = require('node:url')
const path = require('node:path')

const rfdc = require('../../../../vendor/dist/rfdc')({ proto: false, circles: false })
const uuid = require('../../../../vendor/dist/crypto-randomuuid') // we need to keep the old uuid dep because of cypress
const set = require('../../../datadog-core/src/utils/src/set')
const { DD_MAJOR } = require('../../../../version')
const log = require('../log')
const pkg = require('../pkg')
const { isTrue } = require('../util')
const { GIT_REPOSITORY_URL, GIT_COMMIT_SHA } = require('../plugins/util/tags')
const telemetry = require('../telemetry')
const telemetryMetrics = require('../telemetry/metrics')
const {
  IS_SERVERLESS,
  getIsGCPFunction,
  getIsAzureFunction,
} = require('../serverless')
const { ORIGIN_KEY, DATADOG_MINI_AGENT_PATH } = require('../constants')
const { appendRules } = require('../payload-tagging/config')
const { getGitMetadataFromGitProperties, removeUserSensitiveInfo, getRemoteOriginURL, resolveGitHeadSHA } =
  require('./git_properties')
const ConfigBase = require('./config-base')
const {
  getEnvironmentVariable,
  getEnvironmentVariables,
  getStableConfigSources,
  getValueFromEnvSources,
} = require('./helper')
const {
  defaults,
  fallbackConfigurations,
  configurationsTable,
  optionsTable,
  configWithOrigin,
  parseErrors,
  generateTelemetry,
} = require('./defaults')
const { transformers } = require('./parsers')

const RUNTIME_ID = uuid()

const tracerMetrics = telemetryMetrics.manager.namespace('tracers')

/**
 * @typedef {'default'
 * | 'code'
 * | 'remote_config'
 * | 'calculated'
 * | 'env_var'
 * | 'local_stable_config'
 * | 'fleet_stable_config'} TelemetrySource
 * @typedef {'remote_config' | 'calculated'} RevertibleTelemetrySource
 * @typedef {import('../../../../index').TracerOptions} TracerOptions
 * @typedef {import('./config-types').ConfigKey} ConfigKey
 * @typedef {import('./config-types').ConfigPath} ConfigPath
 * @typedef {{
 *   value: import('./config-types').ConfigPathValue<ConfigPath>,
 *   source: TelemetrySource
 * }} TrackedConfigEntry
 * @typedef {{
 *   baseValuesByPath: Partial<Record<ConfigPath, TrackedConfigEntry>>,
 *   remote_config: Set<ConfigPath>,
 *   calculated: Set<ConfigPath>,
 * }} ChangeTracker
 */

/** @type {Config | null} */
let configInstance = null

// An entry that is undefined means it is the default value.
/** @type {Map<ConfigPath, TelemetrySource>} */
const trackedConfigOrigins = new Map()

// ChangeTracker tracks the changes to the config up to programmatic options (code).
/** @type {ChangeTracker} */
const changeTracker = {
  baseValuesByPath: {},
  remote_config: new Set(),
  calculated: new Set(),
}

/**
 * @param {Config} config
 * @param {RevertibleTelemetrySource} source
 */
function undo (config, source) {
  for (const name of changeTracker[source]) {
    const entry = changeTracker.baseValuesByPath[name] ?? { source: 'default', value: defaults[name] }
    setAndTrack(config, name, entry.value, undefined, entry.source)
  }
}

function get (object, path) {
  // Fast path for simple property access.
  if (object[path] !== undefined) {
    return object[path]
  }
  let index = 0
  while (true) {
    const nextIndex = path.indexOf('.', index)
    if (nextIndex === -1) {
      return object[path.slice(index)]
    }
    object = object[path.slice(index, nextIndex)]
    index = nextIndex + 1
  }
}

/**
 * @param {Config} config
 * @template {ConfigPath} TPath
 * @param {TPath} name
 * @param {import('./config-types').ConfigPathValue<TPath>} value
 * @param {unknown} [rawValue]
 * @param {TelemetrySource} [source]
 */
function setAndTrack (config, name, value, rawValue = value, source = 'calculated') {
  // envs can not be undefined
  if (value == null) {
    // TODO: This works as before while ignoring undefined programmatic options is not ideal.
    if (source !== 'default') {
      return
    }
  } else if (source === 'calculated' || source === 'remote_config') {
    if (source === 'calculated' && value === get(config, name)) {
      return
    }
    changeTracker[source].add(name)
  } else {
    const copy = typeof value === 'object' && value !== null ? rfdc(value) : value
    changeTracker.baseValuesByPath[name] = { value: copy, source }
  }
  set(config, name, value)

  generateTelemetry(rawValue, source, name)
  if (source === 'default') {
    trackedConfigOrigins.delete(name)
  } else {
    trackedConfigOrigins.set(name, source)
  }
}

module.exports = getConfig

// We extend from ConfigBase to make our types work
class Config extends ConfigBase {
  /**
   * parsed DD_TAGS, usable as a standalone tag set across products
   * @type {Record<string, string>}
   */
  #parsedDdTags

  /**
   * @type {Record<string, string>}
   */
  get parsedDdTags () {
    return this.#parsedDdTags
  }

  /**
   * @param {TracerOptions} [options={}]
   */
  constructor (options = {}) {
    super()

    const configEnvSources = getStableConfigSources()
    this.stableConfig = {
      fleetEntries: configEnvSources.fleetStableConfig ?? {},
      localEntries: configEnvSources.localStableConfig ?? {},
      warnings: configEnvSources.stableConfigWarnings,
    }

    // Configure the logger first so it can be used to warn about other configs
    // TODO: Implement auto buffering of inside of log module before first
    // configure call. That way the logger is always available and the
    // application doesn't need to configure it first and the configuration
    // happens inside of config instead of inside of log module. If the logger
    // is not deactivated, the buffered logs would be discarded. That way stable
    // config warnings can also be logged directly and do not need special
    // handling.
    this.debug = log.configure(options)

    // Process stable config warnings, if any
    for (const warning of this.stableConfig?.warnings ?? []) {
      log.warn(warning)
    }

    this.#applyDefaults()
    // TODO: Update origin documentation to list all valid sources. Add local_stable_config and fleet_stable_config.
    this.#applyEnvs(getEnvironmentVariables(this.stableConfig.localEntries, true), 'local_stable_config')
    this.#applyEnvs(getEnvironmentVariables(undefined, true), 'env_var')
    this.#applyEnvs(getEnvironmentVariables(this.stableConfig.fleetEntries, true), 'fleet_stable_config')

    // Experimental options are applied first, so they can be overridden by non-experimental options.
    // TODO: When using programmatic options, check if there is a higher
    // priority name in the same options object. Use the highest priority name.
    const { experimental, ...rest } = options
    if (experimental) {
      // @ts-expect-error - Difficult to type this correctly.
      this.#applyOptions(experimental, 'code', 'experimental')
    }
    this.#applyOptions(rest, 'code')
    this.#applyCalculated()

    warnWrongOtelSettings()

    if (this.gitMetadataEnabled) {
      this.#loadGitMetadata()
    }

    parseErrors.clear()
  }

  #applyDefaults () {
    for (const [name, value] of Object.entries(defaults)) {
      set(this, name, value)
    }
  }

  /**
   * @param {import('./helper').TracerEnv} envs
   * @param {'env_var' | 'local_stable_config' | 'fleet_stable_config'} source
   */
  #applyEnvs (envs, source) {
    for (const [name, value] of Object.entries(envs)) {
      const entry = configurationsTable[name]
      // TracePropagationStyle is a special case. It is a single option that is used to set both inject and extract.
      // TODO: Consider what to do with this later
      if (name === 'DD_TRACE_PROPAGATION_STYLE') {
        if (
          getValueFromEnvSources('DD_TRACE_PROPAGATION_STYLE_INJECT') !== undefined ||
          getValueFromEnvSources('DD_TRACE_PROPAGATION_STYLE_EXTRACT') !== undefined
        ) {
          log.warn(
            // eslint-disable-next-line @stylistic/max-len
            'Use either DD_TRACE_PROPAGATION_STYLE or separate DD_TRACE_PROPAGATION_STYLE_INJECT and DD_TRACE_PROPAGATION_STYLE_EXTRACT environment variables'
          )
          continue
        }
        this.#applyEnvs({ DD_TRACE_PROPAGATION_STYLE_INJECT: value, DD_TRACE_PROPAGATION_STYLE_EXTRACT: value }, source)
        continue
      }
      const parsed = entry.parser(value, name, source)
      const transformed = parsed !== undefined && entry.transformer ? entry.transformer(parsed, name, source) : parsed
      const rawValue = transformed !== null && typeof transformed === 'object' ? value : parsed
      setAndTrack(this, entry.property ?? name, transformed, rawValue, source)
    }
  }

  /**
   * @param {TracerOptions} options
   * @param {'code' | 'remote_config'} source
   * @param {string} [root]
   */
  #applyOptions (options, source, root = '') {
    for (const [name, value] of Object.entries(options)) {
      const fullName = root ? `${root}.${name}` : name
      let entry = optionsTable[fullName]
      if (!entry) {
        // TODO: Fix this by by changing remote config to use env styles.
        if (name !== 'tracing' || source !== 'remote_config') {
          log.warn('Unknown option %s with value %o', fullName, value)
          continue
        }
        // @ts-expect-error - The entry is defined in the configurationsTable.
        entry = configurationsTable.tracing
      }

      if (entry.nestedProperties) {
        let matched = false
        if (typeof value === 'object' && value !== null) {
          for (const nestedProperty of entry.nestedProperties) {
            // WARNING: if the property name might be part of the value we look at, this could conflict!
            // Defining an option that receives an object as value may not contain a property that is also
            // potentially a nested property!
            if (Object.hasOwn(value, nestedProperty)) {
              this.#applyOptions(value, source, fullName)
              matched = true
              break
            }
          }
        }
        if (matched) {
          continue
        }
        if (entry.option) {
          entry = entry.option
        } else {
          if (fullName === 'tracePropagationStyle') {
            // TracePropagationStyle is special. It is a single option that is used to set both inject and extract.
            // @ts-expect-error - Difficult to type this correctly.
            this.#applyOptions({ inject: value, extract: value }, source, 'tracePropagationStyle')
          } else {
            log.warn('Unknown option %s with value %o', fullName, value)
          }
          continue
        }
      }
      // TODO: Coerce mismatched types to the expected type, if possible. E.g., strings <> numbers
      const transformed = value !== undefined && entry.transformer ? entry.transformer(value, fullName, source) : value
      setAndTrack(this, entry.property, transformed, value, source)
    }
  }

  /**
   * Set the configuration with remote config settings.
   * Applies remote configuration, recalculates derived values, and merges all configuration sources.
   *
   * @param {TracerOptions|null} options - Configurations received via Remote
   *   Config or null to reset all remote configuration
   */
  setRemoteConfig (options) {
    // Clear all RC-managed fields to ensure previous values don't persist.
    // State is instead managed by the `RCClientLibConfigManager` class
    undo(this, 'remote_config')

    // Special case: if options is null, nothing to apply
    // This happens when all remote configs are removed
    if (options !== null) {
      this.#applyOptions(options, 'remote_config')
    }

    this.#applyCalculated()
  }

  /**
   * @param {ConfigPath} name
   */
  getOrigin (name) {
    return trackedConfigOrigins.get(name) ?? 'default'
  }

  // Handles values calculated from a mixture of options and env vars
  #applyCalculated () {
    undo(this, 'calculated')

    if (this.DD_CIVISIBILITY_AGENTLESS_URL ||
        this.url ||
        os.type() !== 'Windows_NT' &&
        !trackedConfigOrigins.has('hostname') &&
        !trackedConfigOrigins.has('port') &&
        !this.DD_CIVISIBILITY_AGENTLESS_ENABLED &&
        fs.existsSync('/var/run/datadog/apm.socket')) {
      setAndTrack(
        this,
        'url',
        new URL(this.DD_CIVISIBILITY_AGENTLESS_URL || this.url || 'unix:///var/run/datadog/apm.socket')
      )
    }

    if (this.isCiVisibility) {
      setAndTrack(this, 'isServiceUserProvided', trackedConfigOrigins.has('service'))
      this.tags[ORIGIN_KEY] = 'ciapp-test'
    }
    // Compute OTLP logs and metrics URLs to send payloads to the active Datadog Agent
    const agentHostname = this.hostname || /** @type {URL} */ (this.url).hostname

    if (!trackedConfigOrigins.has('dogstatsd.hostname')) {
      setAndTrack(this, 'dogstatsd.hostname', agentHostname)
    }
    // Disable log injection when OTEL logs are enabled
    // OTEL logs and DD log injection are mutually exclusive
    if (this.otelLogsEnabled) {
      setAndTrack(this, 'logInjection', false)
    }
    if (this.otelMetricsEnabled &&
        trackedConfigOrigins.has('OTEL_METRICS_EXPORTER') &&
        this.OTEL_METRICS_EXPORTER === 'none') {
      setAndTrack(this, 'otelMetricsEnabled', false)
    }

    if (this.telemetry.heartbeatInterval) {
      setAndTrack(this, 'telemetry.heartbeatInterval', Math.floor(this.telemetry.heartbeatInterval * 1000))
    }
    if (this.telemetry.extendedHeartbeatInterval) {
      setAndTrack(this, 'telemetry.extendedHeartbeatInterval',
        Math.floor(this.telemetry.extendedHeartbeatInterval * 1000))
    }

    // Enable resourceRenamingEnabled when appsec is enabled and only
    // if DD_TRACE_RESOURCE_RENAMING_ENABLED is not explicitly set
    if (!trackedConfigOrigins.has('resourceRenamingEnabled')) {
      setAndTrack(this, 'resourceRenamingEnabled', this.appsec.enabled ?? false)
    }

    if (!trackedConfigOrigins.has('spanComputePeerService') && this.spanAttributeSchema !== 'v0') {
      setAndTrack(this, 'spanComputePeerService', true)
    }

    if (!this.apmTracingEnabled) {
      setAndTrack(this, 'stats.enabled', false)
    } else if (!trackedConfigOrigins.has('stats.enabled')) {
      setAndTrack(this, 'stats.enabled', getIsGCPFunction() || getIsAzureFunction())
    }

    // TODO: Remove the experimental env vars as a major or deprecate the option?
    if (this.experimental?.b3) {
      if (!this.tracePropagationStyle.inject.includes('b3')) {
        this.tracePropagationStyle.inject.push('b3')
      }
      if (!this.tracePropagationStyle.extract.includes('b3')) {
        this.tracePropagationStyle.extract.push('b3')
      }
      if (!this.tracePropagationStyle.inject.includes('b3 single header')) {
        this.tracePropagationStyle.inject.push('b3 single header')
      }
      if (!this.tracePropagationStyle.extract.includes('b3 single header')) {
        this.tracePropagationStyle.extract.push('b3 single header')
      }
      setAndTrack(this, 'tracePropagationStyle.inject', this.tracePropagationStyle.inject)
      setAndTrack(this, 'tracePropagationStyle.extract', this.tracePropagationStyle.extract)
    }

    if (getEnvironmentVariable('AWS_LAMBDA_FUNCTION_NAME') && !fs.existsSync(DATADOG_MINI_AGENT_PATH)) {
      setAndTrack(this, 'flushInterval', 0)
    }

    if (!trackedConfigOrigins.has('apmTracingEnabled') &&
        trackedConfigOrigins.has('experimental.appsec.standalone.enabled')) {
      setAndTrack(this, 'apmTracingEnabled', !this.experimental.appsec.standalone.enabled)
    }

    if (this.cloudPayloadTagging?.request || this.cloudPayloadTagging?.response) {
      setAndTrack(this, 'cloudPayloadTagging.rules', appendRules(
        this.cloudPayloadTagging.request,
        this.cloudPayloadTagging.response
      ))
    }

    if (this.injectionEnabled) {
      setAndTrack(this, 'instrumentationSource', 'ssi')
    }

    if (!trackedConfigOrigins.has('runtimeMetrics.enabled') && this.OTEL_METRICS_EXPORTER === 'none') {
      setAndTrack(this, 'runtimeMetrics.enabled', false)
    }

    if (!trackedConfigOrigins.has('sampleRate') && trackedConfigOrigins.has('OTEL_TRACES_SAMPLER')) {
      setAndTrack(this, 'sampleRate', getFromOtelSamplerMap(this.OTEL_TRACES_SAMPLER, this.OTEL_TRACES_SAMPLER_ARG))
    }

    if (this.DD_SPAN_SAMPLING_RULES_FILE) {
      try {
        // TODO: Should we log a warning in case this is defined next to spanSamplingRules?
        setAndTrack(this, 'spanSamplingRules', transformers.toCamelCase(JSON.parse(this.DD_SPAN_SAMPLING_RULES_FILE)))
      } catch (error) {
        log.warn('Error reading span sampling rules file %s; %o', this.DD_SPAN_SAMPLING_RULES_FILE, error)
      }
    }

    // All sampler options are tracked as individual values. No need to track the sampler object as a whole.
    this.sampler = {
      rules: this.samplingRules,
      rateLimit: this.rateLimit,
      sampleRate: this.sampleRate,
      spanSamplingRules: this.spanSamplingRules,
    }

    // For LLMObs, we want to auto enable it when other llmobs options are defined.
    if (!this.llmobs.enabled &&
        !trackedConfigOrigins.has('llmobs.enabled') &&
        (trackedConfigOrigins.has('llmobs.agentlessEnabled') ||
        trackedConfigOrigins.has('llmobs.mlApp'))) {
      setAndTrack(this, 'llmobs.enabled', true)
    }

    if (this.OTEL_RESOURCE_ATTRIBUTES) {
      for (const [key, value] of Object.entries(this.OTEL_RESOURCE_ATTRIBUTES)) {
        // Not replacing existing tags keeps the order of the tags as before.
        if (!this.tags[key]) {
          this.tags[key] = value
        }
      }
    }
    if (this.DD_TRACE_TAGS) {
      // TODO: This is a hack to keep the order of the tags as before.
      // That hack is not sufficient, since it does not handle other cases where the tags are set by the user.
      if (trackedConfigOrigins.get('tags') === 'code') {
        for (const [key, value] of Object.entries(this.DD_TRACE_TAGS)) {
          // Not replacing existing tags keeps the order of the tags as before.
          if (!this.tags[key]) {
            this.tags[key] = value
          }
        }
      } else {
        Object.assign(this.tags, this.DD_TRACE_TAGS)
      }
    }

    if (!this.#parsedDdTags) {
      this.#parsedDdTags = rfdc(this.tags)
    }

    if (!this.env && this.tags.env !== undefined) {
      setAndTrack(this, 'env', this.tags.env)
    }

    if (!this.version) {
      setAndTrack(this, 'version', this.tags.version || pkg.version)
      this.tags.version ??= pkg.version
    }

    let isServiceNameInferred = false
    if (!trackedConfigOrigins.has('service')) {
      if (this.tags.service) {
        setAndTrack(this, 'service', this.tags.service)
      } else {
        const NX_TASK_TARGET_PROJECT = getEnvironmentVariable('NX_TASK_TARGET_PROJECT')
        if (NX_TASK_TARGET_PROJECT) {
          if (this.DD_ENABLE_NX_SERVICE_NAME) {
            setAndTrack(this, 'service', NX_TASK_TARGET_PROJECT)
            isServiceNameInferred = true
          } else if (DD_MAJOR < 6) {
            log.warn(
              // eslint-disable-next-line eslint-rules/eslint-log-printf-style
              'NX_TASK_TARGET_PROJECT is set but no service name was configured. In v6, NX_TASK_TARGET_PROJECT will ' +
              'be used as the default service name. Set DD_ENABLE_NX_SERVICE_NAME=true to opt-in to this behavior ' +
              'now, or set a service name explicitly.'
            )
          }
        }
      }

      if (!this.service) {
        const serverlessName = IS_SERVERLESS
          ? (
              getEnvironmentVariable('AWS_LAMBDA_FUNCTION_NAME') ||
              getEnvironmentVariable('FUNCTION_NAME') || // Google Cloud Function Name set by deprecated runtimes
              getEnvironmentVariable('K_SERVICE') || // Google Cloud Function Name set by newer runtimes
              getEnvironmentVariable('WEBSITE_SITE_NAME') // set by Azure Functions
            )
          : undefined

        setAndTrack(this, 'service', serverlessName || pkg.name || 'node')
        this.tags.service ??= /** @type {string} */ (this.service)
        isServiceNameInferred = true
      }
    }
    setAndTrack(this, 'isServiceNameInferred', isServiceNameInferred)

    // Add missing tags, in case they are defined otherwise.
    if (this.service) {
      this.tags.service = this.service
    }
    if (this.env) {
      this.tags.env = this.env
    }
    if (this.version) {
      this.tags.version = this.version
    }
    this.tags['runtime-id'] = RUNTIME_ID

    if (IS_SERVERLESS) {
      setAndTrack(this, 'telemetry.enabled', false)
      setAndTrack(this, 'crashtracking.enabled', false)
      setAndTrack(this, 'remoteConfig.enabled', false)
    }

    // TODO: Should this unconditionally be disabled?
    if (getEnvironmentVariable('JEST_WORKER_ID') && !trackedConfigOrigins.has('telemetry.enabled')) {
      setAndTrack(this, 'telemetry.enabled', false)
    }

    // Experimental agentless APM span intake
    // When enabled, sends spans directly to Datadog intake without an agent
    // TODO: Replace this with a proper configuration
    const agentlessEnabled = isTrue(getEnvironmentVariable('_DD_APM_TRACING_AGENTLESS_ENABLED'))
    if (agentlessEnabled) {
      setAndTrack(this, 'experimental.exporter', 'agentless')
      // Disable client-side stats computation
      setAndTrack(this, 'stats.enabled', false)
      // Enable hostname reporting
      setAndTrack(this, 'reportHostname', true)
      // Disable rate limiting - server-side sampling will be used
      setAndTrack(this, 'sampler.rateLimit', -1)
      // Clear sampling rules - server-side sampling handles this
      setAndTrack(this, 'sampler.rules', [])
      // Agentless intake only accepts 64-bit trace IDs; disable 128-bit generation
      if (!trackedConfigOrigins.has('traceId128BitGenerationEnabled')) {
        setAndTrack(this, 'traceId128BitGenerationEnabled', false)
      }
    }

    // Apply all fallbacks to the calculated config.
    for (const [configName, alias] of fallbackConfigurations) {
      if (!trackedConfigOrigins.has(configName) && trackedConfigOrigins.has(alias)) {
        setAndTrack(this, configName, this[alias])
      }
    }

    const DEFAULT_OTLP_PORT = '4318'
    if (!this.otelLogsUrl) {
      setAndTrack(this, 'otelLogsUrl', `http://${agentHostname}:${DEFAULT_OTLP_PORT}`)
    }
    if (!this.otelMetricsUrl) {
      setAndTrack(this, 'otelMetricsUrl', `http://${agentHostname}:${DEFAULT_OTLP_PORT}/v1/metrics`)
    }

    if (process.platform === 'win32') {
      // OOM monitoring does not work properly on Windows, so it will be disabled.
      deactivateIfEnabledAndWarnOnWindows(this, 'DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED')
      // Profiler sampling contexts are not available on Windows, so features
      // depending on those (code hotspots and endpoint collection) need to be disabled on Windows.
      deactivateIfEnabledAndWarnOnWindows(this, 'DD_PROFILING_CODEHOTSPOTS_ENABLED')
      deactivateIfEnabledAndWarnOnWindows(this, 'DD_PROFILING_ENDPOINT_COLLECTION_ENABLED')
      deactivateIfEnabledAndWarnOnWindows(this, 'DD_PROFILING_CPU_ENABLED')
      deactivateIfEnabledAndWarnOnWindows(this, 'DD_PROFILING_TIMELINE_ENABLED')
      deactivateIfEnabledAndWarnOnWindows(this, 'DD_PROFILING_ASYNC_CONTEXT_FRAME_ENABLED')
    }

    // Single tags update is tracked as a calculated value.
    setAndTrack(this, 'tags', this.tags)

    telemetry.updateConfig([...configWithOrigin.values()], this)
  }

  // TODO: Move outside of config. This is unrelated to the config system.
  #loadGitMetadata () {
    // Try to read Git metadata from the environment variables
    this.repositoryUrl = removeUserSensitiveInfo(this.DD_GIT_REPOSITORY_URL ?? this.tags[GIT_REPOSITORY_URL])
    this.commitSHA = this.DD_GIT_COMMIT_SHA ?? this.tags[GIT_COMMIT_SHA]

    // Otherwise, try to read Git metadata from the git.properties file
    if (!this.repositoryUrl || !this.commitSHA) {
      const DD_GIT_PROPERTIES_FILE = this.DD_GIT_PROPERTIES_FILE
      const gitPropertiesFile = DD_GIT_PROPERTIES_FILE ?? `${process.cwd()}/git.properties`
      try {
        const gitPropertiesString = fs.readFileSync(gitPropertiesFile, 'utf8')
        const { commitSHA, repositoryUrl } = getGitMetadataFromGitProperties(gitPropertiesString)
        this.commitSHA ??= commitSHA
        this.repositoryUrl ??= repositoryUrl
      } catch (error) {
        // Only log error if the user has set a git.properties path
        if (DD_GIT_PROPERTIES_FILE) {
          log.error('Error reading DD_GIT_PROPERTIES_FILE: %s', gitPropertiesFile, error)
        }
      }
    }

    // Otherwise, try to read Git metadata from the .git/ folder
    const DD_GIT_FOLDER_PATH = this.DD_GIT_FOLDER_PATH
    const gitFolderPath = DD_GIT_FOLDER_PATH ?? path.join(process.cwd(), '.git')

    if (!this.repositoryUrl) {
      // Try to read git config (repository URL)
      const gitConfigPath = path.join(gitFolderPath, 'config')
      try {
        const gitConfigContent = fs.readFileSync(gitConfigPath, 'utf8')
        if (gitConfigContent) {
          this.repositoryUrl = getRemoteOriginURL(gitConfigContent)
        }
      } catch (error) {
        // Only log error if the user has set a .git/ path
        if (DD_GIT_FOLDER_PATH) {
          log.error('Error reading git config: %s', gitConfigPath, error)
        }
      }
    }
    // Try to read git HEAD (commit SHA)
    this.commitSHA ??= resolveGitHeadSHA(gitFolderPath)
  }
}

/**
 * @param {Config} config
 * @param {ConfigKey} envVar
 */
function deactivateIfEnabledAndWarnOnWindows (config, envVar) {
  if (config[envVar]) {
    const source = trackedConfigOrigins.get(envVar)
    setAndTrack(config, envVar, false)
    // TODO: Should we log even for default values?
    if (source) {
      log.warn('%s is not supported on Windows. Deactivating. (source: %s)', envVar, source)
    }
  }
}

function increaseCounter (event, ddVar, otelVar) {
  const tags = []
  if (ddVar) {
    tags.push(`config_datadog:${ddVar.toLowerCase()}`)
  }
  tags.push(`config_opentelemetry:${otelVar.toLowerCase()}`)
  tracerMetrics.count(event, tags).inc()
}

function getFromOtelSamplerMap (otelTracesSampler, otelTracesSamplerArg) {
  const OTEL_TRACES_SAMPLER_MAPPING = {
    always_on: 1,
    always_off: 0,
    parentbased_always_on: 1,
    parentbased_always_off: 0,
  }

  const result = OTEL_TRACES_SAMPLER_MAPPING[otelTracesSampler] ?? otelTracesSamplerArg
  if (result === undefined) {
    increaseCounter('otel.env.invalid', 'DD_TRACE_SAMPLE_RATE', 'OTEL_TRACES_SAMPLER')
  }
  return result
}

function warnWrongOtelSettings () {
  // This mostly works for non-aliased environment variables only.
  // TODO: Adjust this to work across all sources.
  for (const [otelEnvVar, ddEnvVar, key] of [
    // eslint-disable-next-line eslint-rules/eslint-env-aliases
    ['OTEL_LOG_LEVEL', 'DD_TRACE_LOG_LEVEL', 'logLevel'],
    // eslint-disable-next-line eslint-rules/eslint-env-aliases
    ['OTEL_PROPAGATORS', 'DD_TRACE_PROPAGATION_STYLE'],
    // eslint-disable-next-line eslint-rules/eslint-env-aliases
    ['OTEL_SERVICE_NAME', 'DD_SERVICE', 'service'],
    ['OTEL_TRACES_SAMPLER', 'DD_TRACE_SAMPLE_RATE'],
    ['OTEL_TRACES_SAMPLER_ARG', 'DD_TRACE_SAMPLE_RATE'],
    ['OTEL_TRACES_EXPORTER', 'DD_TRACE_ENABLED'],
    ['OTEL_METRICS_EXPORTER', 'DD_RUNTIME_METRICS_ENABLED'],
    ['OTEL_RESOURCE_ATTRIBUTES', 'DD_TAGS'],
    ['OTEL_SDK_DISABLED', 'DD_TRACE_OTEL_ENABLED'],
    ['OTEL_LOGS_EXPORTER'],
  ]) {
    // eslint-disable-next-line eslint-rules/eslint-process-env
    const envs = process.env
    const otelSource = trackedConfigOrigins.get(/** @type {ConfigPath} */ (key ?? otelEnvVar))
    const otelEnvValue = envs[otelEnvVar]
    if (otelEnvValue) {
      if (envs[ddEnvVar]) {
        log.warn('Conflicting %s and %s environment variables are set for %s', ddEnvVar, otelEnvVar, otelSource)
        increaseCounter('otel.env.hiding', ddEnvVar, otelEnvVar)
      }

      // eslint-disable-next-line eslint-rules/eslint-env-aliases
      const invalidOtelValue = otelEnvVar === 'OTEL_PROPAGATORS'
        ? trackedConfigOrigins.get(/** @type {ConfigPath} */ ('tracePropagationStyle.inject')) !== otelSource &&
          !envs[ddEnvVar]
        : !otelSource
      if (invalidOtelValue) {
        increaseCounter('otel.env.invalid', ddEnvVar, otelEnvVar)
      }
    }
  }
}

/**
 * @param {TracerOptions} [options]
 */
function getConfig (options) {
  if (!configInstance) {
    configInstance = new Config(options)
  }
  return configInstance
}
