'use strict'

const { oomExportStrategies } = require('../constants')
const { encodeProfileAsync, getThreadLabels } = require('./shared')

function strategiesToCallbackMode (strategies, callbackMode) {
  return strategies.includes(oomExportStrategies.ASYNC_CALLBACK) ? callbackMode.Async : 0
}

class NativeSpaceProfiler {
  type = 'space'
  _pprof
  _started = false

  constructor (options = {}) {
    this._samplingInterval = options.heapSamplingInterval || 512 * 1024
    this._stackDepth = options.stackDepth || 64
    this._oomMonitoring = options.oomMonitoring || {}
  }

  start ({ mapper, nearOOMCallback } = {}) {
    if (this._started) return

    this._mapper = mapper
    this._pprof = require('@datadog/pprof')
    this._pprof.heap.start(this._samplingInterval, this._stackDepth)
    if (this._oomMonitoring.enabled) {
      const strategies = this._oomMonitoring.exportStrategies
      this._pprof.heap.monitorOutOfMemory(
        this._oomMonitoring.heapLimitExtensionSize,
        this._oomMonitoring.maxHeapExtensionCount,
        strategies.includes(oomExportStrategies.LOGS),
        strategies.includes(oomExportStrategies.PROCESS) ? this._oomMonitoring.exportCommand : [],
        (profile) => nearOOMCallback(this.type, this._pprof.encodeSync(profile)),
        strategiesToCallbackMode(strategies, this._pprof.heap.CallbackMode)
      )
    }

    this._started = true
  }

  profile (restart) {
    const profile = this._pprof.heap.profile(undefined, this._mapper, getThreadLabels)
    if (!restart) {
      this.stop()
    }
    return profile
  }

  encode (profile) {
    return encodeProfileAsync(profile)
  }

  stop () {
    if (!this._started) return
    this._pprof.heap.stop()
    this._started = false
  }

  isStarted () {
    return this._started
  }
}

module.exports = NativeSpaceProfiler
