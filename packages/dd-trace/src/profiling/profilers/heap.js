'use strict'

const kStartSampleRate = 512 * 1024
const kDefaultThreshold = 0.25

function totalBytes (profile) {
  let bytes = 0
  for (const sample of profile.sample) {
    bytes += sample.value[1]
  }
  return bytes
}

class NativeHeapProfiler {
  constructor (options = {}) {
    this.type = 'space'
    this._samplingInterval = options.samplingInterval || kStartSampleRate
    this._threshold = options.samplingThreshold || kDefaultThreshold
    this._stackDepth = options.stackDepth || 64
    this._pprof = undefined
  }

  start () {
    if (!this._pprof) {
      this._pprof = require('@datadog/pprof')
    }
    this._pprof.heap.start(this._samplingInterval, this._stackDepth)
  }

  profile () {
    const profile = this._pprof.heap.profile()

    // Bucket to 99hz
    const bytes = Math.floor(totalBytes(profile) / 60 / 99)
    const currentSampleRate = this._samplingInterval
    const delta = currentSampleRate * this._threshold

    // Update sample rate if the difference between expected and actual
    // sample rates are larger than the configured threshold.
    if (Math.abs(bytes - currentSampleRate) > delta) {
      this._samplingInterval = bytes
      this.stop()
      this.start()
    }

    return profile
  }

  encode (profile) {
    return this._pprof.encode(profile)
  }

  stop () {
    this._pprof.heap.stop()
  }
}

module.exports = NativeHeapProfiler
