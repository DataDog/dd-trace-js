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
  #nearOOMCallback
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

    this.#mapper = mapper
    this.#nearOOMCallback = nearOOMCallback
    this.#pprof = require('@datadog/pprof')
    this.#pprof.heap.start(this.#samplingInterval, STACK_DEPTH, this.#config.DD_PROFILING_ALLOCATION_ENABLED)
    this.#registerOOMExport()

    this.#started = true
  }

  /**
   * Refreshes the tags baked into the OOM export command after a MicroVM clone resume, so PROCESS-strategy
   * heap dumps carry the clone's identity instead of the snapshot's. Re-registering via monitorOutOfMemory()
   * is safe: the native binding replaces the previously stored export command/callback on the same OOM
   * handler rather than stacking a duplicate one.
   *
   * @param {Record<string, string>} tags
   */
  refreshTags (tags) {
    this.#tags = tags
    if (!this.#started) return
    this.#registerOOMExport()
  }

  /**
   * Registers (or re-registers) the near-OOM handler with the currently configured tags. Safe to call
   * more than once: monitorOutOfMemory() replaces the previously registered export command and callback
   * on the same native handler rather than adding a second one. No-ops if OOM monitoring is disabled.
   */
  #registerOOMExport () {
    const config = this.#config
    if (!config.DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED) return

    const strategies = ensureOOMExportStrategies(config.DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES)
    this.#pprof.heap.monitorOutOfMemory(
      config.DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE,
      config.DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT,
      strategies.includes(oomExportStrategies.LOGS),
      strategies.includes(oomExportStrategies.PROCESS) ? buildExportCommand(this.#exporters, this.#tags) : [],
      (profile) => this.#nearOOMCallback(this.type, this.#pprof.encodeSync(profile), this.getInfo()),
      strategiesToCallbackMode(strategies, this.#pprof.heap.CallbackMode)
    )
  }

  profile (restart) {
    const profile = this.#pprof.heap.profile(undefined, this.#mapper, getThreadLabels, 'pack')
    if (!restart) {
      this.stop()
    }
    return profile
  }

  getInfo () {}

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
