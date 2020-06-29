'use strict'

const { maybeRequire } = require('../../util')

class NativeHeapProfiler {
  constructor (options = {}) {
    this.type = 'space'
    this._pprof = maybeRequire('pprof')
    this._samplingInterval = options.samplingInterval || 512 * 1024
    this._stackDepth = options.stackDepth || 64
  }

  start () {
    this._pprof.heap.start(this._samplingInterval, this._stackDepth)
  }

  profile () {
    return this._pprof.heap.profile()
  }

  stop () {
    this._pprof.heap.stop()
  }
}

module.exports = { NativeHeapProfiler }
