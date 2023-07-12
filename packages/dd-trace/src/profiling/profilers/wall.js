'use strict'

class NativeWallProfiler {
  constructor (options = {}) {
    this.type = 'wall'
    this._samplingIntervalMicros = options.samplingInterval || 1e6 / 99 // 99hz
    this._flushIntervalMillis = options.flushInterval || 60 * 1e3 // 60 seconds
    this._codeHotspotsEnabled = !!options.codeHotspotsEnabled
    this._mapper = undefined
    this._pprof = undefined

    this._logger = options.logger
    this._started = false
  }

  start ({ mapper } = {}) {
    if (this._started) return

    this._mapper = mapper
    this._pprof = require('@datadog/pprof')

    // pprof otherwise crashes in worker threads
    if (!process._startProfilerIdleNotifier) {
      process._startProfilerIdleNotifier = () => {}
    }
    if (!process._stopProfilerIdleNotifier) {
      process._stopProfilerIdleNotifier = () => {}
    }

    this._pprof.time.start({
      intervalMicros: this._samplingIntervalMicros,
      durationMillis: this._flushIntervalMillis,
      sourceMapper: this._mapper,
      customLabels: this._codeHotspotsEnabled,
      lineNumbers: false
    })

    this._started = true
  }

  profile () {
    if (!this._started) return
    return this._pprof.time.stop(true)
  }

  encode (profile) {
    return this._pprof.encode(profile)
  }

  stop () {
    if (!this._started) return

    const profile = this._pprof.time.stop()
    this._started = false
    return profile
  }
}

module.exports = NativeWallProfiler
