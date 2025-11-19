'use strict'

const { oomExportStrategies } = require('../constants')
const { encodeProfileAsync, getThreadLabels } = require('./shared')

function strategiesToCallbackMode (strategies, callbackMode) {
  return strategies.includes(oomExportStrategies.ASYNC_CALLBACK) ? callbackMode.Async : 0
}

const STACK_DEPTH = 64

class NativeSpaceProfiler {
  #mapper
  #oomMonitoring
  #pprof
  #samplingInterval = 512 * 1024
  #started = false

  constructor (options = {}) {
    // TODO: Remove default value. It is only used in testing.
    this.#samplingInterval = options.heapSamplingInterval || 512 * 1024
    this.#oomMonitoring = options.oomMonitoring || {}
  }

  get type () {
    return 'space'
  }

  start ({ mapper, nearOOMCallback } = {}) {
    if (this.#started) return

    this.#mapper = mapper
    this.#pprof = require('@datadog/pprof')
    this.#pprof.heap.start(this.#samplingInterval, STACK_DEPTH)
    if (this.#oomMonitoring.enabled) {
      const strategies = this.#oomMonitoring.exportStrategies
      this.#pprof.heap.monitorOutOfMemory(
        this.#oomMonitoring.heapLimitExtensionSize,
        this.#oomMonitoring.maxHeapExtensionCount,
        strategies.includes(oomExportStrategies.LOGS),
        strategies.includes(oomExportStrategies.PROCESS) ? this.#oomMonitoring.exportCommand : [],
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
