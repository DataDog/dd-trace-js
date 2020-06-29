'use strict'

const { maybeRequire } = require('../../util')

class NativeCpuProfiler {
  constructor (options = {}) {
    this.type = 'wall'
    this._pprof = maybeRequire('pprof')
    this._samplingInterval = options.samplingInterval || 10 * 1000
  }

  start () {
    // pprof otherwise crashes in worker threads
    if (!process._startProfilerIdleNotifier) {
      process._startProfilerIdleNotifier = () => {}
    }

    this._record()
  }

  profile () {
    const profile = this._stop()

    this._record()

    return profile
  }

  stop () {
    this._stop()
  }

  _record () {
    this._stop = this._pprof.time.start(this._samplingInterval)
  }
}

module.exports = { NativeCpuProfiler }
