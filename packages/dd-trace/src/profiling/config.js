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
const { getEnvironmentVariable } = require('../config/helper')
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
  let [method, level0] = config.profiling.debugUploadCompression.split('-')
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
  const enabled = config.profiling.asyncContextFrameEnabled ?? isACFActive
  if (enabled && !isACFActive) {
    let reason
    if (satisfies(process.versions.node, '>=24.0.0')) {
      reason = 'with --no-async-context-frame'
    } else if (satisfies(process.versions.node, '>=22.9.0')) {
      reason = 'without --experimental-async-context-frame'
    } else {
      reason = 'but it requires at least Node.js 22.9.0'
    }
    log.warn('DD_PROFILING_ASYNC_CONTEXT_FRAME_ENABLED was set %s, it will have no effect.', reason)
    return false
  }
  return enabled
}

// Allocation profiling requires a sampling hook only available on Node.js 26+.
/** @param {TracerConfig} config */
function getAllocationProfilingEnabled (config) {
  return NODE_MAJOR >= 26 && config.profiling.allocationEnabled
}

/** @param {TracerConfig} config */
function createExporters (config) {
  return config.profiling.exporters.map((exporter) => getExporter(exporter, config))
}

/**
 * @param {TracerConfig} config
 * @param {ProfilingExporter[]} exporters
 * @param {Record<string, string>} tags
 */
function getOomMonitoring (config, exporters, tags) {
  const enabled = config.profiling.experimentalOomMonitoringEnabled
  return {
    enabled,
    heapLimitExtensionSize: config.profiling.experimentalOomHeapLimitExtensionSize,
    maxHeapExtensionCount: config.profiling.experimentalOomMaxHeapExtensionCount,
    exportStrategies: enabled
      ? ensureOOMExportStrategies(config.profiling.experimentalOomExportStrategies)
      : [],
    exportCommand: enabled ? buildExportCommand(config, exporters, tags) : undefined,
  }
}

/**
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
  for (const name of selectProfilerTypes(config.profiling)) {
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
  if (config.profiling.timelineEnabled && profilers.some(profiler => profiler instanceof WallProfiler)) {
    profilers.push(new EventsProfiler(config, { flushInterval, samplingInterval: SAMPLING_INTERVAL }))
  }

  return profilers
}

/** @param {TracerConfig['profiling']} profiling */
function selectProfilerTypes ({ heapEnabled, walltimeEnabled, profilers: requested }) {
  // First consider "legacy" DD_PROFILING_PROFILERS env variable, defaulting to space + wall
  // Use a Set to avoid duplicates
  // NOTE: space profiler is very deliberately in the first position. This way
  // when profilers are stopped sequentially one after the other to create
  // snapshots the space profile won't include memory taken by profiles created
  // before it in the sequence. That memory is ultimately transient and will be
  // released when all profiles are subsequently encoded.
  const profilers = new Set(requested)

  let spaceExplicitlyEnabled = false
  // Add/remove space depending on the value of DD_PROFILING_HEAP_ENABLED
  if (heapEnabled !== undefined) {
    if (heapEnabled) {
      if (!profilers.has('space')) {
        profilers.add('space')
        spaceExplicitlyEnabled = true
      }
    } else {
      profilers.delete('space')
    }
  }

  // Add/remove wall depending on the value of DD_PROFILING_WALLTIME_ENABLED
  if (walltimeEnabled !== undefined) {
    if (walltimeEnabled) {
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
      urls.push(pathToFileURL(config.profiling.pprofPrefix).toString())
    }
  }
  return [process.execPath,
    path.join(__dirname, 'exporter_cli.js'),
    urls.join(','), tagString, 'space']
}

module.exports = {
  SAMPLING_INTERVAL,
  createExporters,
  createProfilers,
  getAllocationProfilingEnabled,
  getAsyncContextFrameEnabled,
  getOomMonitoring,
  getProfilingTags,
  getUploadCompression,
}
