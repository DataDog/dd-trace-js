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
const { oomExportStrategies, snapshotKinds } = require('./constants')
const { tagger } = require('./tagger')
const { isFalse, isTrue } = require('../util')

class Config {
  constructor (options = {}) {
    const {
      DD_PROFILING_ENABLED,
      DD_PROFILING_PROFILERS,
      DD_ENV,
      DD_TAGS,
      DD_SERVICE,
      DD_VERSION,
      DD_TRACE_AGENT_URL,
      DD_AGENT_HOST,
      DD_TRACE_AGENT_PORT,
      DD_PROFILING_DEBUG_SOURCE_MAPS,
      DD_PROFILING_UPLOAD_TIMEOUT,
      DD_PROFILING_SOURCE_MAP,
      DD_PROFILING_UPLOAD_PERIOD,
      DD_PROFILING_PPROF_PREFIX,
      DD_PROFILING_HEAP_ENABLED,
      DD_PROFILING_V8_PROFILER_BUG_WORKAROUND,
      DD_PROFILING_WALLTIME_ENABLED,
      DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED,
      DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE,
      DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT,
      DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES,
      DD_PROFILING_EXPERIMENTAL_CODEHOTSPOTS_ENABLED,
      DD_PROFILING_EXPERIMENTAL_ENDPOINT_COLLECTION_ENABLED
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
    const endpointCollectionEnabled = coalesce(options.endpointCollection,
      DD_PROFILING_EXPERIMENTAL_ENDPOINT_COLLECTION_ENABLED, false)
    const pprofPrefix = coalesce(options.pprofPrefix,
      DD_PROFILING_PPROF_PREFIX, '')

    this.enabled = enabled
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
    this.logger = ensureLogger(options.logger)
    this.flushInterval = flushInterval
    this.uploadTimeout = uploadTimeout
    this.sourceMap = sourceMap
    this.debugSourceMaps = isTrue(coalesce(options.debugSourceMaps, DD_PROFILING_DEBUG_SOURCE_MAPS, false))
    this.endpointCollectionEnabled = endpointCollectionEnabled
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

    const oomMonitoringEnabled = isTrue(coalesce(options.oomMonitoring,
      DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED, true))
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
      : getProfilers({ DD_PROFILING_HEAP_ENABLED, DD_PROFILING_WALLTIME_ENABLED, DD_PROFILING_PROFILERS })
    this.codeHotspotsEnabled = isTrue(coalesce(options.codeHotspotsEnabled,
      DD_PROFILING_EXPERIMENTAL_CODEHOTSPOTS_ENABLED, false))

    this.profilers = ensureProfilers(profilers, this)
  }
}

module.exports = { Config }

function getProfilers ({ DD_PROFILING_HEAP_ENABLED, DD_PROFILING_WALLTIME_ENABLED, DD_PROFILING_PROFILERS }) {
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

  return [ ...new Set(strategies) ]
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
