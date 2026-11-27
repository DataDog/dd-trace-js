'use strict'

const { channel } = require('dc-polyfill')

const log = require('../../log')
const { oomExportStrategies, ensureOOMExportStrategies, strategiesToCallbackMode, buildExportCommand } =
  require('../oom')
const { getThreadLabels } = require('./shared')

/** @typedef {import('../../config/config-base')} TracerConfig */
/** @typedef {import('@datadog/pprof').CapturedProfile} CapturedProfile */
/**
 * @typedef {import('../exporters/agent').AgentExporter
 *   | import('../exporters/file').FileExporter} ProfilingExporter
 */

const STACK_DEPTH = 64
const identityRefreshChannel = channel('datadog:identity:refresh')

class NativeSpaceProfiler {
  collectsAllocations = false
  #config
  #exporters
  #identityRefreshListener
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

    this.#mapper = mapper
    this.#pprof = require('@datadog/pprof')
    this.collectsAllocations = this.#config.DD_PROFILING_ALLOCATION_ENABLED
    this.#pprof.heap.start(this.#samplingInterval, STACK_DEPTH, this.collectsAllocations)

    if (this.#config.DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED) {
      const config = this.#config
      const strategies = ensureOOMExportStrategies(config.DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES)
      const monitorOutOfMemory = () => {
        this.#pprof.heap.monitorOutOfMemory(
          config.DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE,
          config.DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT,
          strategies.includes(oomExportStrategies.LOGS),
          strategies.includes(oomExportStrategies.PROCESS) ? buildExportCommand(this.#exporters, this.#tags) : [],
          (profile) => nearOOMCallback(this.type, this.#pprof.encodeSync(profile), this.getInfo()),
          strategiesToCallbackMode(strategies, this.#pprof.heap.CallbackMode)
        )
      }
      monitorOutOfMemory()

      if (strategies.includes(oomExportStrategies.PROCESS)) {
        this.#identityRefreshListener = () => {
          try {
            Object.assign(this.#tags, config.tags)
            monitorOutOfMemory()
          } catch (error) {
            log.error(error)
          }
        }
        identityRefreshChannel.subscribe(this.#identityRefreshListener)
      }
    }

    this.#started = true
  }

  /**
   * @param {boolean} restart
   * @returns {CapturedProfile}
   */
  capture (restart) {
    const captured = this.#pprof.heap.capture({
      sourceMapper: this.#mapper,
      generateLabels: getThreadLabels,
    })
    if (!restart) {
      this.stop()
    }
    return captured
  }

  /**
   * How pprof profiles of the captured profiles are built: frames carry their column only for server-side
   * unminification.
   *
   * @returns {import('@datadog/pprof').PprofSerializerOptions}
   */
  get pprofBuilderOptions () {
    return { columnNumbers: 'emit' }
  }

  getInfo () {}

  stop () {
    if (!this.#started) return

    if (this.#identityRefreshListener !== undefined) {
      identityRefreshChannel.unsubscribe(this.#identityRefreshListener)
      this.#identityRefreshListener = undefined
    }

    this.#pprof.heap.stop()
    this.#started = false
  }

  isStarted () {
    return this.#started
  }
}

module.exports = NativeSpaceProfiler
