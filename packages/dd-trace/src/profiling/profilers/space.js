'use strict'

const { oomExportStrategies, ensureOOMExportStrategies, strategiesToCallbackMode, buildExportCommand } =
  require('../oom')
const { encodeProfileAsync, getThreadLabels } = require('./shared')

/** @typedef {import('../../config/config-base')} TracerConfig */
/**
 * @typedef {import('../exporters/agent').AgentExporter
 *   | import('../exporters/file').FileExporter} ProfilingExporter
 */

const STACK_DEPTH = 64

class NativeSpaceProfiler {
  #config
  #exporters
  #mapper
  #pprof
  #samplingInterval
  #started = false
  #tags

  /**
   * @param {TracerConfig} config
   * @param {{ tags: Record<string, string>, exporters: ProfilingExporter[] }} runtime
   */
  constructor (config, { tags, exporters }) {
    this.#config = config
    this.#tags = tags
    this.#exporters = exporters
    this.#samplingInterval = config.DD_PROFILING_HEAP_SAMPLING_INTERVAL
  }

  get type () {
    return 'space'
  }

  start ({ mapper, nearOOMCallback } = {}) {
    if (this.#started) return

    const config = this.#config
    this.#mapper = mapper
    this.#pprof = require('@datadog/pprof')
    this.#pprof.heap.start(this.#samplingInterval, STACK_DEPTH, config.DD_PROFILING_ALLOCATION_ENABLED)
    if (config.DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED) {
      const strategies = ensureOOMExportStrategies(config.DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES)
      this.#pprof.heap.monitorOutOfMemory(
        config.DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE,
        config.DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT,
        strategies.includes(oomExportStrategies.LOGS),
        strategies.includes(oomExportStrategies.PROCESS) ? buildExportCommand(this.#exporters, this.#tags) : [],
        (profile) => nearOOMCallback(this.type, this.#pprof.encodeSync(profile), this.getInfo()),
        strategiesToCallbackMode(strategies, this.#pprof.heap.CallbackMode)
      )
    }

    this.#started = true
  }

  profile (restart) {
    const profile = this.#pprof.heap.profile(undefined, this.#mapper, getThreadLabels)
    if (!restart) {
      this.stop()
    }
    return profile
  }

  getInfo () {
    return {}
  }

  encode (profile) {
    return encodeProfileAsync(profile)
  }

  stop () {
    if (!this.#started) return
    this.#pprof.heap.stop()
    this.#started = false
  }

  isStarted () {
    return this.#started
  }
}

module.exports = NativeSpaceProfiler
