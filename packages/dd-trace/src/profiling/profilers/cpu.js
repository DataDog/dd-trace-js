'use strict'

class NativeCpuProfiler {
  constructor (options = {}) {
    this.type = 'wall'
    this._samplingInterval = options.samplingInterval || 10 * 1000
    this._mapper = undefined
    this._pprof = undefined
  }

  start ({ mapper } = {}) {
    this._mapper = mapper
    this._pprof = require('@datadog/pprof')

    // pprof otherwise crashes in worker threads
    if (!process._startProfilerIdleNotifier) {
      process._startProfilerIdleNotifier = () => {}
    }
    if (!process._stopProfilerIdleNotifier) {
      process._stopProfilerIdleNotifier = () => {}
    }

    this._record()
  }

  profile () {
    if (!this._stop) return
    // Next profile MUST be started before previous ends otherwise V8 will tear
    // down the symbolizer thread and start a new one when the next one starts.
    const stop = this._stop
    this._record()
    return stop()
  }

  encode (profile) {
    return this._pprof.encode(profile)
  }

  stop () {
    if (!this._stop) return
    this._stop()
  }

  _record () {
    this._stop = this._pprof.time.start(this._samplingInterval, null,
      this._mapper)
  }
}

module.exports = NativeCpuProfiler
