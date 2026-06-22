'use strict'

const path = require('path')
const { pathToFileURL } = require('url')

const satisfies = require('../../../../vendor/dist/semifies')
const { NODE_MAJOR } = require('../../../../version')
const getGitMetadata = require('../git_metadata')
const log = require('../log')
const { GIT_REPOSITORY_URL, GIT_COMMIT_SHA } = require('../plugins/util/tags')
const { getIsAzureFunction } = require('../serverless')
const { getAzureTagsFromMetadata, getAzureAppMetadata, getAzureFunctionMetadata } = require('../azure_metadata')
const { getEnvironmentVariable, getValueFromEnvSources } = require('../config/helper')
const { isACFActive } = require('../../../datadog-core/src/storage')

const { AgentExporter } = require('./exporters/agent')
const { FileExporter } = require('./exporters/file')
const WallProfiler = require('./profilers/wall')
const SpaceProfiler = require('./profilers/space')
const EventsProfiler = require('./profilers/events')
const { oomExportStrategies, snapshotKinds } = require('./constants')
const { tagger } = require('./tagger')

/** @typedef {import('../config/config-base')} TracerConfig */
/** @typedef {AgentExporter | FileExporter} ProfilingExporter */
/** @typedef {WallProfiler | SpaceProfiler | EventsProfiler} ProfilingProfiler */

// 99hz in milliseconds.
const SAMPLING_INTERVAL = 1e3 / 99

/** @param {TracerConfig} config */
function getProfilingTags (config) {
  const functionName = getEnvironmentVariable('AWS_LAMBDA_FUNCTION_NAME')

  const tags = {
    ...config.tags,
    ...tagger.parse({
      host: config.reportHostname ? require('os').hostname() : undefined,
      functionname: functionName,
    }),
    ...getAzureTagsFromMetadata(getIsAzureFunction() ? getAzureFunctionMetadata() : getAzureAppMetadata()),
  }

  const { commitSHA, repositoryUrl } = getGitMetadata(config)
  if (repositoryUrl && commitSHA) {
    tags[GIT_REPOSITORY_URL] = repositoryUrl
    tags[GIT_COMMIT_SHA] = commitSHA
  }

  return tags
}

/** @param {TracerConfig} config */
function getUploadCompression (config) {
  let [method, level0] = config.DD_PROFILING_DEBUG_UPLOAD_COMPRESSION.split('-')
  let level = level0 ? Number.parseInt(level0, 10) : undefined
  if (level !== undefined) {
    const maxLevel = { gzip: 9, zstd: 22 }[method]
    if (level > maxLevel) {
      log.warn('Invalid compression level %d. Will use %d.', level, maxLevel)
      level = maxLevel
    }
  }

  // Default to either zstd (on Node.js 24+) or gzip (earlier Node.js). We could default to ztsd
  // everywhere as we ship a Rust zstd compressor for older Node.js versions, but on 24+ we use
  // the built-in one that runs asynchronously on libuv worker threads, just as gzip does. This is
  // the least disruptive choice.
  if (method === 'on') {
    method = satisfies(process.versions.node, '>=24.0.0') ? 'zstd' : 'gzip'
  }

  return { method, level }
}

/** @param {TracerConfig} config */
function getAsyncContextFrameEnabled (config) {
  const enabled = config.DD_PROFILING_ASYNC_CONTEXT_FRAME_ENABLED
  if (enabled && !isACFActive) {
    // The default value already tracks runtime support, so an unset config landing
    // here is expected; only an explicit opt-in the runtime can't honor is worth a warning.
    if (getValueFromEnvSources('DD_PROFILING_ASYNC_CONTEXT_FRAME_ENABLED', true)) {
      let reason
      if (satisfies(process.versions.node, '>=24.0.0')) {
        reason = 'with --no-async-context-frame'
      } else if (satisfies(process.versions.node, '>=22.9.0')) {
        reason = 'without --experimental-async-context-frame'
      } else {
        reason = 'but it requires at least Node.js 22.9.0'
      }
      log.warn('DD_PROFILING_ASYNC_CONTEXT_FRAME_ENABLED was set %s, it will have no effect.', reason)
    }
    return false
  }
  return enabled
}

// Allocation profiling requires a sampling hook only available on Node.js 26+.
/** @param {TracerConfig} config */
function getAllocationProfilingEnabled (config) {
  return NODE_MAJOR >= 26 && config.DD_PROFILING_ALLOCATION_ENABLED
}

/** @param {TracerConfig} config */
function createExporters (config) {
  return config.DD_PROFILING_EXPORTERS.map((exporter) => getExporter(exporter, config))
}

/**
 * @param {TracerConfig} config
 * @param {ProfilingExporter[]} exporters
 * @param {Record<string, string>} tags
 */
function getOomMonitoring (config, exporters, tags) {
  const enabled = config.DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED
  return {
    enabled,
    heapLimitExtensionSize: config.DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE,
    maxHeapExtensionCount: config.DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT,
    exportStrategies: enabled ? ensureOOMExportStrategies(config.DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES) : [],
    exportCommand: enabled ? buildExportCommand(config, exporters, tags) : undefined,
  }
}

/**
 * Leaves read the canonical DD_PROFILING_* fields straight off the tracer config; only the values
 * that genuinely need a translation (ACF resolution, allocation gating, period→millis, the sampling
 * constant, OOM monitoring) are computed here and passed through.
 *
 * @param {TracerConfig} config
 * @param {{
 *   oomMonitoring: ReturnType<typeof getOomMonitoring>,
 *   asyncContextFrameEnabled: boolean,
 *   allocationProfilingEnabled: boolean,
 *   flushInterval: number,
 * }} derived
 */
function createProfilers (config, {
  oomMonitoring,
  asyncContextFrameEnabled,
  allocationProfilingEnabled,
  flushInterval,
}) {
  const profilers = []
  for (const name of selectProfilerTypes(config)) {
    switch (name) {
      case 'cpu':
      case 'wall':
        profilers.push(new WallProfiler(config, {
          asyncContextFrameEnabled,
          flushInterval,
          samplingInterval: SAMPLING_INTERVAL,
        }))
        break
      case 'space':
        profilers.push(new SpaceProfiler(config, { oomMonitoring, allocationProfilingEnabled }))
        break
      default:
        log.error('Unknown profiler "%s"', name)
    }
  }

  // The events profiler produces timeline events. It is only added if timeline
  // is enabled and there's a wall profiler.
  if (config.DD_PROFILING_TIMELINE_ENABLED && profilers.some(profiler => profiler instanceof WallProfiler)) {
    profilers.push(new EventsProfiler(config, { flushInterval, samplingInterval: SAMPLING_INTERVAL }))
  }

  return profilers
}

/** @param {TracerConfig} config */
function selectProfilerTypes ({
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

/** @param {string} name */
function getExportStrategy (name) {
  const strategy = Object.values(oomExportStrategies).find(value => value === name)
  if (strategy === undefined) {
    log.error('Unknown oom export strategy "%s"', name)
  }
  return strategy
}

/** @param {string[]} strategies */
function ensureOOMExportStrategies (strategies) {
  const set = new Set()
  for (const strategy of strategies) {
    set.add(getExportStrategy(strategy))
  }

  return [...set]
}

/**
 * @param {string} name
 * @param {TracerConfig} config
 */
function getExporter (name, config) {
  switch (name) {
    case 'agent':
      return new AgentExporter(config)
    case 'file':
      return new FileExporter(config)
    default:
      log.error('Unknown exporter "%s"', name)
  }
}

/**
 * Assembles everything the profiler needs from the tracer config in one place: the derived values
 * that need translation and the system info report sent with each profile. Both the runtime
 * {@link import('./profiler').Profiler#start} and the config spec drive this, so the wiring has a
 * single home and the test cannot drift from production.
 *
 * @param {TracerConfig} config
 */
function buildProfilingRuntime (config) {
  const tags = getProfilingTags(config)
  const exporters = createExporters(config)
  const oomMonitoring = getOomMonitoring(config, exporters, tags)
  const asyncContextFrameEnabled = getAsyncContextFrameEnabled(config)
  const allocationProfilingEnabled = getAllocationProfilingEnabled(config)
  const flushInterval = config.DD_PROFILING_UPLOAD_PERIOD * 1000
  const profilers = createProfilers(config, {
    oomMonitoring,
    asyncContextFrameEnabled,
    allocationProfilingEnabled,
    flushInterval,
  })
  const uploadCompression = getUploadCompression(config)

  const systemInfoReport = {
    allocationProfilingEnabled,
    asyncContextFrameEnabled,
    codeHotspotsEnabled: config.DD_PROFILING_CODEHOTSPOTS_ENABLED,
    cpuProfilingEnabled: config.DD_PROFILING_CPU_ENABLED,
    debugSourceMaps: config.DD_PROFILING_DEBUG_SOURCE_MAPS,
    endpointCollectionEnabled: config.DD_PROFILING_ENDPOINT_COLLECTION_ENABLED,
    heapSamplingInterval: config.DD_PROFILING_HEAP_SAMPLING_INTERVAL,
    oomMonitoring: { ...oomMonitoring },
    profilerTypes: profilers.map(profiler => profiler.type),
    sourceMap: config.DD_PROFILING_SOURCE_MAP,
    timelineEnabled: config.DD_PROFILING_TIMELINE_ENABLED,
    timelineSamplingEnabled: config.DD_INTERNAL_PROFILING_TIMELINE_SAMPLING_ENABLED,
    uploadCompression: { ...uploadCompression },
    v8ProfilerBugWorkaroundEnabled: config.DD_PROFILING_V8_PROFILER_BUG_WORKAROUND,
  }
  // The export command is an internal OOM detail, not part of the reported settings.
  delete systemInfoReport.oomMonitoring.exportCommand

  return { tags, exporters, flushInterval, oomMonitoring, profilers, uploadCompression, systemInfoReport }
}

/**
 * @param {TracerConfig} config
 * @param {ProfilingExporter[]} exporters
 * @param {Record<string, string>} tags
 */
function buildExportCommand (config, exporters, tags) {
  const tagString = [...Object.entries(tags),
    ['snapshot', snapshotKinds.ON_OUT_OF_MEMORY]].map(([key, value]) => `${key}:${value}`).join(',')
  const urls = []
  for (const exporter of exporters) {
    if (exporter instanceof AgentExporter) {
      urls.push(config.url.toString())
    } else if (exporter instanceof FileExporter) {
      urls.push(pathToFileURL(config.DD_PROFILING_PPROF_PREFIX).toString())
    }
  }
  return [process.execPath,
    path.join(__dirname, 'exporter_cli.js'),
    urls.join(','), tagString, 'space']
}

module.exports = {
  SAMPLING_INTERVAL,
  buildProfilingRuntime,
}
