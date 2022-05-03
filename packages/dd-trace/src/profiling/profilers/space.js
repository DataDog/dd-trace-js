'use strict'

class NativeSpaceProfiler {
  constructor (options = {}) {
    this.type = 'space'
    this._samplingInterval = options.samplingInterval || 512 * 1024
    this._stackDepth = options.stackDepth || 64
    this._pprof = undefined
  }

  start ({ mapper } = {}) {
    this._mapper = mapper
    this._pprof = require('@datadog/pprof')
    this._pprof.heap.start(this._samplingInterval, this._stackDepth)
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
