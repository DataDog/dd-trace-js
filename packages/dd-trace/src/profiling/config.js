'use strict'

const path = require('path')
const { pathToFileURL } = require('url')

const satisfies = require('../../../../vendor/dist/semifies')
const { GIT_REPOSITORY_URL, GIT_COMMIT_SHA } = require('../plugins/util/tags')
const { getIsAzureFunction } = require('../serverless')
const { getAzureTagsFromMetadata, getAzureAppMetadata, getAzureFunctionMetadata } = require('../azure_metadata')
const { getEnvironmentVariable } = require('../config/helper')
const { getAgentUrl } = require('../agent/url')
const { isACFActive } = require('../../../datadog-core/src/storage')

const { AgentExporter } = require('./exporters/agent')
const { FileExporter } = require('./exporters/file')
const { ConsoleLogger } = require('./loggers/console')
const WallProfiler = require('./profilers/wall')
const SpaceProfiler = require('./profilers/space')
const EventsProfiler = require('./profilers/events')
const { oomExportStrategies, snapshotKinds } = require('./constants')
const { tagger } = require('./tagger')

class Config {
  constructor (options) {
    const AWS_LAMBDA_FUNCTION_NAME = getEnvironmentVariable('AWS_LAMBDA_FUNCTION_NAME')

    this.version = options.version
    this.service = options.service
    this.env = options.env
    this.functionname = AWS_LAMBDA_FUNCTION_NAME

    this.tags = {
      ...options.tags,
      ...tagger.parse({
        host: options.reportHostname ? require('os').hostname() : undefined,
        functionname: AWS_LAMBDA_FUNCTION_NAME,
      }),
      ...getAzureTagsFromMetadata(getIsAzureFunction() ? getAzureFunctionMetadata() : getAzureAppMetadata()),
    }

    // Add source code integration tags if available
    if (options.repositoryUrl && options.commitSHA) {
      this.tags[GIT_REPOSITORY_URL] = options.repositoryUrl
      this.tags[GIT_COMMIT_SHA] = options.commitSHA
    }

    // Normalize from seconds to milliseconds. Default must be longer than a minute.
    this.flushInterval = options.DD_PROFILING_UPLOAD_PERIOD * 1000
    this.uploadTimeout = options.DD_PROFILING_UPLOAD_TIMEOUT
    this.sourceMap = options.DD_PROFILING_SOURCE_MAP
    this.debugSourceMaps = options.DD_PROFILING_DEBUG_SOURCE_MAPS
    this.endpointCollectionEnabled = options.DD_PROFILING_ENDPOINT_COLLECTION_ENABLED
    this.pprofPrefix = options.DD_PROFILING_PPROF_PREFIX
    this.v8ProfilerBugWorkaroundEnabled = options.DD_PROFILING_V8_PROFILER_BUG_WORKAROUND

    this.logger = ensureLogger(options.logger)
    this.url = getAgentUrl(options)

    this.libraryInjected = !!options.DD_INJECTION_ENABLED

    let activation
    if (options.profiling.enabled === 'auto') {
      activation = 'auto'
    } else if (options.profiling.enabled === 'true') {
      activation = 'manual'
    } // else activation = undefined

    this.activation = activation
    this.exporters = ensureExporters(options.DD_PROFILING_EXPORTERS, this)

    const oomMonitoringEnabled = options.DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED
    const heapLimitExtensionSize = options.DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE
    const maxHeapExtensionCount = options.DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT
    const exportStrategies = oomMonitoringEnabled
      ? ensureOOMExportStrategies(options.DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES, this)
      : []
    const exportCommand = oomMonitoringEnabled ? buildExportCommand(this) : undefined
    this.oomMonitoring = {
      enabled: oomMonitoringEnabled,
      heapLimitExtensionSize,
      maxHeapExtensionCount,
      exportStrategies,
      exportCommand,
    }

    const profilers = getProfilers(options)

    this.timelineEnabled = options.DD_PROFILING_TIMELINE_ENABLED
    this.timelineSamplingEnabled = options.DD_INTERNAL_PROFILING_TIMELINE_SAMPLING_ENABLED
    this.codeHotspotsEnabled = options.DD_PROFILING_CODEHOTSPOTS_ENABLED
    this.cpuProfilingEnabled = options.DD_PROFILING_CPU_ENABLED
    this.heapSamplingInterval = options.DD_PROFILING_HEAP_SAMPLING_INTERVAL

    this.samplingInterval = 1e3 / 99 // 99hz in milliseconds

    const isAtLeast24 = satisfies(process.versions.node, '>=24.0.0')

    const uploadCompression0 = options.DD_PROFILING_DEBUG_UPLOAD_COMPRESSION
    let [uploadCompression, level0] = uploadCompression0.split('-')
    let level = level0 ? Number.parseInt(level0, 10) : undefined
    if (level !== undefined) {
      const maxLevel = { gzip: 9, zstd: 22 }[uploadCompression]
      if (level > maxLevel) {
        this.logger.warn(`Invalid compression level ${level}. Will use ${maxLevel}.`)
        level = maxLevel
      }
    }

    // Default to either zstd (on Node.js 24+) or gzip (earlier Node.js). We could default to ztsd
    // everywhere as we ship a Rust zstd compressor for older Node.js versions, but on 24+ we use
    // the built-in one that runs asynchronously on libuv worker threads, just as gzip does. This is
    // the least disruptive choice.
    if (uploadCompression === 'on') {
      uploadCompression = isAtLeast24 ? 'zstd' : 'gzip'
    }

    this.uploadCompression = { method: uploadCompression, level }

    const that = this
    function turnOffAsyncContextFrame (msg) {
      that.logger.warn(
        `DD_PROFILING_ASYNC_CONTEXT_FRAME_ENABLED was set ${msg}, it will have no effect.`)
      that.asyncContextFrameEnabled = false
    }

    this.asyncContextFrameEnabled = options.DD_PROFILING_ASYNC_CONTEXT_FRAME_ENABLED ?? isACFActive
    if (this.asyncContextFrameEnabled && !isACFActive) {
      if (isAtLeast24) {
        turnOffAsyncContextFrame('with --no-async-context-frame')
      } else if (satisfies(process.versions.node, '>=22.9.0')) {
        turnOffAsyncContextFrame('without --experimental-async-context-frame')
      } else {
        turnOffAsyncContextFrame('but it requires at least Node.js 22.9.0')
      }
    }

    this.heartbeatInterval = options.telemetry.heartbeatInterval

    this.profilers = ensureProfilers(profilers, this)
  }

  get systemInfoReport () {
    const report = {
      asyncContextFrameEnabled: this.asyncContextFrameEnabled,
      codeHotspotsEnabled: this.codeHotspotsEnabled,
      cpuProfilingEnabled: this.cpuProfilingEnabled,
      debugSourceMaps: this.debugSourceMaps,
      endpointCollectionEnabled: this.endpointCollectionEnabled,
      heapSamplingInterval: this.heapSamplingInterval,
      oomMonitoring: { ...this.oomMonitoring },
      profilerTypes: this.profilers.map(profiler => profiler.type),
      sourceMap: this.sourceMap,
      timelineEnabled: this.timelineEnabled,
      timelineSamplingEnabled: this.timelineSamplingEnabled,
      uploadCompression: { ...this.uploadCompression },
      v8ProfilerBugWorkaroundEnabled: this.v8ProfilerBugWorkaroundEnabled,
    }
    delete report.oomMonitoring.exportCommand
    return report
  }
}

module.exports = { Config }

function getProfilers ({
  DD_PROFILING_HEAP_ENABLED,
  DD_PROFILING_WALLTIME_ENABLED,
  DD_PROFILING_PROFILERS,
}) {
  // First consider "legacy" DD_PROFILING_PROFILERS env variable, defaulting to space + wall
  // Use a Set to avoid duplicates
  // NOTE: space profiler is very deliberately in the first position. This way
  // when profilers are stopped sequentially one after the other to create
  // snapshots the space profile won't include memory taken by profiles created
  // before it in the sequence. That memory is ultimately transient and will be
  // released when all profiles are subsequently encoded.
  const profilers = new Set(DD_PROFILING_PROFILERS)

  let spaceExplicitlyEnabled = false
  // Add/remove space depending on the value of DD_PROFILING_HEAP_ENABLED
  if (DD_PROFILING_HEAP_ENABLED !== undefined) {
    if (DD_PROFILING_HEAP_ENABLED) {
      if (!profilers.has('space')) {
        profilers.add('space')
        spaceExplicitlyEnabled = true
      }
    } else {
      profilers.delete('space')
    }
  }

  // Add/remove wall depending on the value of DD_PROFILING_WALLTIME_ENABLED
  if (DD_PROFILING_WALLTIME_ENABLED !== undefined) {
    if (DD_PROFILING_WALLTIME_ENABLED) {
      profilers.add('wall')
    } else {
      profilers.delete('wall')
      profilers.delete('cpu') // remove alias too
    }
  }

  const profilersArray = [...profilers]
  // If space was added through DD_PROFILING_HEAP_ENABLED, ensure it is in the
  // first position. Basically, the only way for it not to be in the first
  // position is if it was explicitly specified in a different position in
  // DD_PROFILING_PROFILERS.
  if (spaceExplicitlyEnabled) {
    const spaceIdx = profilersArray.indexOf('space')
    if (spaceIdx > 0) {
      profilersArray.splice(spaceIdx, 1)
      profilersArray.unshift('space')
    }
  }
  return profilersArray
}

function getExportStrategy (name, options) {
  const strategy = Object.values(oomExportStrategies).find(value => value === name)
  if (strategy === undefined) {
    options.logger.error(`Unknown oom export strategy "${name}"`)
  }
  return strategy
}

function ensureOOMExportStrategies (strategies, options) {
  const set = new Set()
  for (const strategy of strategies) {
    set.add(getExportStrategy(strategy, options))
  }

  return [...set]
}

function getExporter (name, options) {
  switch (name) {
    case 'agent':
      return new AgentExporter(options)
    case 'file':
      return new FileExporter(options)
    default:
      options.logger.error(`Unknown exporter "${name}"`)
  }
}

function ensureExporters (exporters, options) {
  return exporters.map((exporter) => getExporter(exporter, options))
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
  const filteredProfilers = []

  for (let i = 0; i < profilers.length; i++) {
    const profiler = getProfiler(profilers[i], options)
    if (profiler !== undefined) {
      filteredProfilers.push(profiler)
    }
  }

  // Events profiler is a profiler that produces timeline events. It is only
  // added if timeline is enabled and there's a wall profiler.
  if (options.timelineEnabled && filteredProfilers.some(profiler => profiler instanceof WallProfiler)) {
    filteredProfilers.push(new EventsProfiler(options))
  }

  return filteredProfilers
}

function ensureLogger (logger) {
  if (typeof logger?.debug !== 'function' ||
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
