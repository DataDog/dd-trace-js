'use strict'

const coalesce = require('koalas')
const os = require('os')
const path = require('path')
const { URL, format, pathToFileURL } = require('url')
const { AgentExporter } = require('./exporters/agent')
const { FileExporter } = require('./exporters/file')
const { ConsoleLogger } = require('./loggers/console')
const WallProfiler = require('./profilers/wall')
const SpaceProfiler = require('./profilers/space')
const EventsProfiler = require('./profilers/events')
const { oomExportStrategies, snapshotKinds } = require('./constants')
const { GIT_REPOSITORY_URL, GIT_COMMIT_SHA } = require('../plugins/util/tags')
const { tagger } = require('./tagger')
const { isFalse, isTrue } = require('../util')

class Config {
  constructor (options = {}) {
    const {
      DD_AGENT_HOST,
      DD_ENV,
      DD_PROFILING_CODEHOTSPOTS_ENABLED,
      DD_PROFILING_CPU_ENABLED,
      DD_PROFILING_DEBUG_SOURCE_MAPS,
      DD_PROFILING_ENABLED,
      DD_PROFILING_ENDPOINT_COLLECTION_ENABLED,
      DD_PROFILING_EXPERIMENTAL_CODEHOTSPOTS_ENABLED,
      DD_PROFILING_EXPERIMENTAL_CPU_ENABLED,
      DD_PROFILING_EXPERIMENTAL_ENDPOINT_COLLECTION_ENABLED,
      DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES,
      DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE,
      DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT,
      DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED,
      DD_PROFILING_EXPERIMENTAL_TIMELINE_ENABLED,
      DD_PROFILING_HEAP_ENABLED,
      DD_PROFILING_PPROF_PREFIX,
      DD_PROFILING_PROFILERS,
      DD_PROFILING_SOURCE_MAP,
      DD_PROFILING_TIMELINE_ENABLED,
      DD_PROFILING_UPLOAD_PERIOD,
      DD_PROFILING_UPLOAD_TIMEOUT,
      DD_PROFILING_V8_PROFILER_BUG_WORKAROUND,
      DD_PROFILING_WALLTIME_ENABLED,
      DD_SERVICE,
      DD_TAGS,
      DD_TRACE_AGENT_PORT,
      DD_TRACE_AGENT_URL,
      DD_VERSION
    } = process.env

    const enabled = isTrue(coalesce(options.enabled, DD_PROFILING_ENABLED, true))
    const env = coalesce(options.env, DD_ENV)
    const service = options.service || DD_SERVICE || 'node'
    const host = os.hostname()
    const version = coalesce(options.version, DD_VERSION)
    const functionname = process.env.AWS_LAMBDA_FUNCTION_NAME
    // Must be longer than one minute so pad with five seconds
    const flushInterval = coalesce(options.interval, Number(DD_PROFILING_UPLOAD_PERIOD) * 1000, 65 * 1000)
    const uploadTimeout = coalesce(options.uploadTimeout,
      Number(DD_PROFILING_UPLOAD_TIMEOUT), 60 * 1000)
    const sourceMap = coalesce(options.sourceMap,
      DD_PROFILING_SOURCE_MAP, true)
    const pprofPrefix = coalesce(options.pprofPrefix,
      DD_PROFILING_PPROF_PREFIX, '')

    this.enabled = enabled
    this.heuristicsEnabled = options.heuristicsEnabled
    this.service = service
    this.env = env
    this.host = host
    this.functionname = functionname

    this.version = version
    this.tags = Object.assign(
      tagger.parse(DD_TAGS),
      tagger.parse(options.tags),
      tagger.parse({ env, host, service, version, functionname })
    )

    // Add source code integration tags if available
    if (options.repositoryUrl && options.commitSHA) {
      this.tags[GIT_REPOSITORY_URL] = options.repositoryUrl
      this.tags[GIT_COMMIT_SHA] = options.commitSHA
    }

    this.logger = ensureLogger(options.logger)
    const logger = this.logger
    function logExperimentalVarDeprecation (shortVarName) {
      const deprecatedEnvVarName = `DD_PROFILING_EXPERIMENTAL_${shortVarName}`
      const v = process.env[deprecatedEnvVarName]
      // not null, undefined, or NaN -- same logic as koalas.hasValue
      // eslint-disable-next-line no-self-compare
      if (v != null && v === v) {
        logger.warn(`${deprecatedEnvVarName} is deprecated. Use DD_PROFILING_${shortVarName} instead.`)
      }
    }
    // Profiler sampling contexts are not available on Windows, so features
    // depending on those (code hotspots and endpoint collection) need to default
    // to false on Windows.
    const samplingContextsAvailable = process.platform !== 'win32'
    function checkOptionAllowed (option, description, condition) {
      if (option && !condition) {
        throw new Error(`${description} not supported on ${process.platform}.`)
      }
    }
    function checkOptionWithSamplingContextAllowed (option, description) {
      checkOptionAllowed(option, description, samplingContextsAvailable)
    }

    this.flushInterval = flushInterval
    this.uploadTimeout = uploadTimeout
    this.sourceMap = sourceMap
    this.debugSourceMaps = isTrue(coalesce(options.debugSourceMaps, DD_PROFILING_DEBUG_SOURCE_MAPS, false))
    this.endpointCollectionEnabled = isTrue(coalesce(options.endpointCollection,
      DD_PROFILING_ENDPOINT_COLLECTION_ENABLED,
      DD_PROFILING_EXPERIMENTAL_ENDPOINT_COLLECTION_ENABLED, samplingContextsAvailable))
    logExperimentalVarDeprecation('ENDPOINT_COLLECTION_ENABLED')
    checkOptionWithSamplingContextAllowed(this.endpointCollectionEnabled, 'Endpoint collection')

    this.pprofPrefix = pprofPrefix
    this.v8ProfilerBugWorkaroundEnabled = isTrue(coalesce(options.v8ProfilerBugWorkaround,
      DD_PROFILING_V8_PROFILER_BUG_WORKAROUND, true))
    const hostname = coalesce(options.hostname, DD_AGENT_HOST) || 'localhost'
    const port = coalesce(options.port, DD_TRACE_AGENT_PORT) || 8126
    this.url = new URL(coalesce(options.url, DD_TRACE_AGENT_URL, format({
      protocol: 'http:',
      hostname,
      port
    })))

    this.exporters = ensureExporters(options.exporters || [
      new AgentExporter(this)
    ], this)

    // OOM monitoring does not work well on Windows, so it is disabled by default.
    const oomMonitoringSupported = process.platform !== 'win32'

    const oomMonitoringEnabled = isTrue(coalesce(options.oomMonitoring,
      DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED, oomMonitoringSupported))
    checkOptionAllowed(oomMonitoringEnabled, 'OOM monitoring', oomMonitoringSupported)

    const heapLimitExtensionSize = coalesce(options.oomHeapLimitExtensionSize,
      Number(DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE), 0)
    const maxHeapExtensionCount = coalesce(options.oomMaxHeapExtensionCount,
      Number(DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT), 0)
    const exportStrategies = oomMonitoringEnabled
      ? ensureOOMExportStrategies(coalesce(options.oomExportStrategies, DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES,
        [oomExportStrategies.PROCESS]), this)
      : []
    const exportCommand = oomMonitoringEnabled ? buildExportCommand(this) : undefined
    this.oomMonitoring = {
      enabled: oomMonitoringEnabled,
      heapLimitExtensionSize,
      maxHeapExtensionCount,
      exportStrategies,
      exportCommand
    }

    const profilers = options.profilers
      ? options.profilers
      : getProfilers({
        DD_PROFILING_HEAP_ENABLED,
        DD_PROFILING_WALLTIME_ENABLED,
        DD_PROFILING_PROFILERS
      })

    this.timelineEnabled = isTrue(coalesce(options.timelineEnabled,
      DD_PROFILING_TIMELINE_ENABLED,
      DD_PROFILING_EXPERIMENTAL_TIMELINE_ENABLED, samplingContextsAvailable))
    logExperimentalVarDeprecation('TIMELINE_ENABLED')
    checkOptionWithSamplingContextAllowed(this.timelineEnabled, 'Timeline view')

    this.codeHotspotsEnabled = isTrue(coalesce(options.codeHotspotsEnabled,
      DD_PROFILING_CODEHOTSPOTS_ENABLED,
      DD_PROFILING_EXPERIMENTAL_CODEHOTSPOTS_ENABLED, samplingContextsAvailable))
    logExperimentalVarDeprecation('CODEHOTSPOTS_ENABLED')
    checkOptionWithSamplingContextAllowed(this.codeHotspotsEnabled, 'Code hotspots')

    this.cpuProfilingEnabled = isTrue(coalesce(options.cpuProfilingEnabled,
      DD_PROFILING_CPU_ENABLED,
      DD_PROFILING_EXPERIMENTAL_CPU_ENABLED, samplingContextsAvailable))
    logExperimentalVarDeprecation('CPU_ENABLED')
    checkOptionWithSamplingContextAllowed(this.cpuProfilingEnabled, 'CPU profiling')

    this.profilers = ensureProfilers(profilers, this)
  }
}

module.exports = { Config }

function getProfilers ({
  DD_PROFILING_HEAP_ENABLED, DD_PROFILING_WALLTIME_ENABLED, DD_PROFILING_PROFILERS
}) {
  // First consider "legacy" DD_PROFILING_PROFILERS env variable, defaulting to wall + space
  // Use a Set to avoid duplicates
  const profilers = new Set(coalesce(DD_PROFILING_PROFILERS, 'wall,space').split(','))

  // Add/remove wall depending on the value of DD_PROFILING_WALLTIME_ENABLED
  if (DD_PROFILING_WALLTIME_ENABLED != null) {
    if (isTrue(DD_PROFILING_WALLTIME_ENABLED)) {
      profilers.add('wall')
    } else if (isFalse(DD_PROFILING_WALLTIME_ENABLED)) {
      profilers.delete('wall')
    }
  }

  // Add/remove wall depending on the value of DD_PROFILING_HEAP_ENABLED
  if (DD_PROFILING_HEAP_ENABLED != null) {
    if (isTrue(DD_PROFILING_HEAP_ENABLED)) {
      profilers.add('space')
    } else if (isFalse(DD_PROFILING_HEAP_ENABLED)) {
      profilers.delete('space')
    }
  }

  return [...profilers]
}

function getExportStrategy (name, options) {
  const strategy = Object.values(oomExportStrategies).find(value => value === name)
  if (strategy === undefined) {
    options.logger.error(`Unknown oom export strategy "${name}"`)
  }
  return strategy
}

function ensureOOMExportStrategies (strategies, options) {
  if (!strategies) {
    return []
  }

  if (typeof strategies === 'string') {
    strategies = strategies.split(',')
  }

  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i]
    if (typeof strategy === 'string') {
      strategies[i] = getExportStrategy(strategy, options)
    }
  }

  return [...new Set(strategies)]
}

function getExporter (name, options) {
  switch (name) {
    case 'agent':
      return new AgentExporter(options)
    case 'file':
      return new FileExporter(options)
  }
}

function ensureExporters (exporters, options) {
  if (typeof exporters === 'string') {
    exporters = exporters.split(',')
  }

  for (let i = 0; i < exporters.length; i++) {
    const exporter = exporters[i]
    if (typeof exporter === 'string') {
      exporters[i] = getExporter(exporter, options)
    }
  }

  return exporters
}

function getProfiler (name, options) {
  switch (name) {
    case 'cpu':
    case 'wall':
      return new WallProfiler(options)
    case 'space':
      return new SpaceProfiler(options)
    default:
      options.logger.error(`Unknown profiler "${name}"`)
  }
}

function ensureProfilers (profilers, options) {
  if (typeof profilers === 'string') {
    profilers = profilers.split(',')
  }

  for (let i = 0; i < profilers.length; i++) {
    const profiler = profilers[i]
    if (typeof profiler === 'string') {
      profilers[i] = getProfiler(profiler, options)
    }
  }

  // Events profiler is a profiler that produces timeline events. It is only
  // added if timeline is enabled and there's a wall profiler.
  if (options.timelineEnabled && profilers.some(p => p instanceof WallProfiler)) {
    profilers.push(new EventsProfiler(options))
  }

  // Filter out any invalid profilers
  return profilers.filter(v => v)
}

function ensureLogger (logger) {
  if (typeof logger !== 'object' ||
    typeof logger.debug !== 'function' ||
    typeof logger.info !== 'function' ||
    typeof logger.warn !== 'function' ||
    typeof logger.error !== 'function') {
    return new ConsoleLogger()
  }

  return logger
}

function buildExportCommand (options) {
  const tags = [...Object.entries(options.tags),
    ['snapshot', snapshotKinds.ON_OUT_OF_MEMORY]].map(([key, value]) => `${key}:${value}`).join(',')
  const urls = []
  for (const exporter of options.exporters) {
    if (exporter instanceof AgentExporter) {
      urls.push(options.url.toString())
    } else if (exporter instanceof FileExporter) {
      urls.push(pathToFileURL(options.pprofPrefix).toString())
    }
  }
  return [process.execPath,
    path.join(__dirname, 'exporter_cli.js'),
    urls.join(','), tags, 'space']
}
