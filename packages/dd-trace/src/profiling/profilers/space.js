'use strict'

const path = require('node:path')
const { SnapshotKinds, OOMExportStrategies } = require('../constants')

function strategiesToCallbackMode (strategies, CallbackMode) {
  return (strategies.includes(OOMExportStrategies.InteruptCallback) ? CallbackMode.Interrupt : 0) |
    (strategies.includes(OOMExportStrategies.AsyncCallback) ? CallbackMode.Async : 0)
}

class NativeSpaceProfiler {
  constructor (options = {}) {
    this.type = 'space'
    this._samplingInterval = options.samplingInterval || 512 * 1024
    this._stackDepth = options.stackDepth || 64
    this._pprof = undefined
    this._oomMonitoring = options.oomMonitoring || false
    this._oomHeapLimitExtensionSize = options.oomHeapLimitExtensionSize || 0
    this._oomMaxHeapExtensionCount = options.oomMaxHeapExtensionCount || 0
    this._oomExportStrategies = options.oomExportStrategies || 0
    if (this._oomMonitoring) {
      const tags = [...Object.entries(options.tags),
        ['snapshot', SnapshotKinds.OnOutOfMemory]].map(([key, value]) => `${key}:${value}`).join(',')
      this._oomExportCommand = [process.execPath,
        path.join(__dirname, '..', 'exporter_cli.js'),
        options.url.toString(), tags, this.type]
    }
  }

  start ({ mapper, nearOOMCallback } = {}) {
    this._mapper = mapper
    this._pprof = require('@datadog/pprof')
    this._pprof.heap.start(this._samplingInterval, this._stackDepth)
    if (this._oomMonitoring.enabled) {
      const strategies = this._oomMonitoring.exportStrategies
      this._pprof.heap.monitorOutOfMemory(
        this._oomMonitoring.heapLimitExtensionSize,
        this._oomMonitoring.maxHeapExtensionCount,
        strategies.includes(OOMExportStrategies.Logs),
        strategies.includes(OOMExportStrategies.Process) ? this._oomExportCommand : [],
        (profile) => nearOOMCallback(this.type, this._pprof.encodeSync(profile)),
        strategiesToCallbackMode(strategies, this._pprof.heap.CallbackMode)
      )
    }
  }

  profile () {
    return this._pprof.heap.profile(undefined, this._mapper)
  }

  encode (profile) {
    return this._pprof.encode(profile)
  }

  stop () {
    this._pprof.heap.stop()
  }
}

module.exports = NativeSpaceProfiler
