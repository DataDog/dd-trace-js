'use strict'

const satisfies = require('../../../../vendor/dist/semifies')
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
const { ensureOOMExportStrategies } = require('./oom')
const { tagger } = require('./tagger')

/** @typedef {import('../config/config-base')} TracerConfig */
/** @typedef {AgentExporter | FileExporter} ProfilingExporter */
/** @typedef {WallProfiler | SpaceProfiler | EventsProfiler} ProfilingProfiler */

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

/**
 * @param {TracerConfig} config
 * @param {{
 *   asyncContextFrameEnabled: boolean,
 *   flushInterval: number,
 *   tags: Record<string, string>,
 *   exporters: ProfilingExporter[],
 * }} runtime
 */
function createProfilers (config, { asyncContextFrameEnabled, flushInterval, tags, exporters }) {
  const profilers = []
  for (const name of selectProfilerTypes(config)) {
    switch (name) {
      case 'cpu':
      case 'wall':
        profilers.push(new WallProfiler(config, { asyncContextFrameEnabled, flushInterval }))
        break
      case 'space':
        profilers.push(new SpaceProfiler(config, { tags, exporters }))
        break
      default:
        log.error('Unknown profiler "%s"', name)
    }
  }

  // The events profiler produces timeline events. It is only added if timeline
  // is enabled and there's a wall profiler.
  if (config.DD_PROFILING_TIMELINE_ENABLED && profilers.some(profiler => profiler instanceof WallProfiler)) {
    profilers.push(new EventsProfiler(config, { flushInterval }))
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
 * Assembles everything the profiler needs from the tracer config: the runtime objects (tags,
 * exporters, profilers) the {@link import('./profiler').Profiler#start} consumes and the system
 * info report sent with each profile. The leaves read the canonical DD_PROFILING_* fields straight
 * off the config; only the genuinely runtime values (tags, exporters, the resolved async context
 * frame flag, the flush interval) are derived here.
 *
 * @param {TracerConfig} config
 */
function buildProfilingRuntime (config) {
  const tags = getProfilingTags(config)
  const exporters = []
  for (const name of config.DD_PROFILING_EXPORTERS) {
    const exporter = getExporter(name, config)
    // getExporter logs and returns undefined for an unknown exporter name; drop it so a misconfigured
    // DD_PROFILING_EXPORTERS entry can't crash the export path later.
    if (exporter !== undefined) {
      exporters.push(exporter)
    }
  }
  const asyncContextFrameEnabled = getAsyncContextFrameEnabled(config)
  const flushInterval = config.DD_PROFILING_UPLOAD_PERIOD * 1000
  const profilers = createProfilers(config, { asyncContextFrameEnabled, flushInterval, tags, exporters })
  const uploadCompression = config.DD_PROFILING_DEBUG_UPLOAD_COMPRESSION

  const oomMonitoringEnabled = config.DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED
  const systemInfoReport = {
    allocationProfilingEnabled: config.DD_PROFILING_ALLOCATION_ENABLED,
    asyncContextFrameEnabled,
    codeHotspotsEnabled: config.DD_PROFILING_CODEHOTSPOTS_ENABLED,
    cpuProfilingEnabled: config.DD_PROFILING_CPU_ENABLED,
    debugSourceMaps: config.DD_PROFILING_DEBUG_SOURCE_MAPS,
    endpointCollectionEnabled: config.DD_PROFILING_ENDPOINT_COLLECTION_ENABLED,
    heapSamplingInterval: config.DD_PROFILING_HEAP_SAMPLING_INTERVAL,
    oomMonitoring: {
      enabled: oomMonitoringEnabled,
      heapLimitExtensionSize: config.DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE,
      maxHeapExtensionCount: config.DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT,
      exportStrategies: oomMonitoringEnabled
        ? ensureOOMExportStrategies(config.DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES)
        : [],
    },
    profilerTypes: profilers.map(profiler => profiler.type),
    sourceMap: config.DD_PROFILING_SOURCE_MAP,
    timelineEnabled: config.DD_PROFILING_TIMELINE_ENABLED,
    timelineSamplingEnabled: config.DD_INTERNAL_PROFILING_TIMELINE_SAMPLING_ENABLED,
    uploadCompression: { ...uploadCompression },
    v8ProfilerBugWorkaroundEnabled: config.DD_PROFILING_V8_PROFILER_BUG_WORKAROUND,
  }

  return { tags, exporters, flushInterval, profilers, uploadCompression, systemInfoReport }
}

module.exports = {
  buildProfilingRuntime,
}
