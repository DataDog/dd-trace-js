'use strict'

class NativeHeapProfiler {
  constructor (options = {}) {
    this.type = 'space'
    this._samplingInterval = options.samplingInterval || 512 * 1024
    this._stackDepth = options.stackDepth || 64
    this._logger = undefined
    this._pprof = undefined
  }

  start ({ logger } = {}) {
    this._logger = logger

    try {
      this._pprof = require('pprof')
    } catch (err) {
      if (this._logger) {
        this._logger.error(err)
      }
    }

    if (!this._pprof) return

    this._pprof.heap.start(this._samplingInterval, this._stackDepth)
  }

  profile () {
    if (!this._pprof) return
    const profile = this._pprof.heap.profile()
    return this._pprof.encode(profile)
  }

  stop () {
    if (!this._pprof) return
    this._pprof.heap.stop()
  }
}

module.exports = NativeHeapProfiler
