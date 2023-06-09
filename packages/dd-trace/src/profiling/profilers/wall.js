'use strict'

const { storage } = require('../../../../datadog-core')

const dc = require('../../../../diagnostics_channel')

const beforeCh = dc.channel('dd-trace:storage:before')
const afterCh = dc.channel('dd-trace:storage:after')
const incomingHttpRequestStart = dc.channel('dd-trace:incomingHttpRequestStart')
const incomingHttpRequestEnd = dc.channel('dd-trace:incomingHttpRequestEnd')

function getActiveSpan () {
  const store = storage.getStore()
  if (!store) return
  return store.span
}

class NativeWallProfiler {
  constructor (options = {}) {
    this.type = 'wall'
    // input as micros, passed on as micros
    this._samplingInterval = options.samplingInterval || 1e6 / 99 // 99hz
    // input as millis, passed on as micros
    this._flushInterval = options.flushInterval * 1000 || 60 * 1e6 // 60 seconds
    this._hotspots = options.hotspots
    this._mapper = undefined
    this._pprof = undefined

    // Bind to this so the same value can be used to unsubscribe later
    this._enter = this._enter.bind(this)
    this._exit = this._exit.bind(this)
    this._logger = options.logger
  }

  resetStack () {
    this._currentLabels = undefined
    this._labelStack = []
  }

  start ({ mapper } = {}) {
    if (this._hotspots && !this._emittedFFMessage && this._logger) {
      this._logger.debug(`Wall profiler: Enable config_trace_show_breakdown_profiling_for_node feature flag to see code hotspots.`)
      this._emittedFFMessage = true
    }

    this._mapper = mapper
    this._pprof = require('@datadog/pprof')

    // pprof otherwise crashes in worker threads
    if (!process._startProfilerIdleNotifier) {
      process._startProfilerIdleNotifier = () => {}
    }
    if (!process._stopProfilerIdleNotifier) {
      process._stopProfilerIdleNotifier = () => {}
    }

    this.resetStack()
    this._record()
    if (this._hotspots) {
      beforeCh.subscribe(this._enter)
      afterCh.subscribe(this._exit)
      incomingHttpRequestStart.subscribe(this._enter)
      incomingHttpRequestEnd.subscribe(this._exit)
    }
  }

  setLabels (labels) {
    this._currentLabels = labels
    this._setLabels(labels)
  }

  _enter () {
    if (!this._setLabels) return

    const currentSpan = getActiveSpan() || null

    const activeCtx = currentSpan ? currentSpan.context() : null

    const labels = activeCtx ? {
      'span id': activeCtx.toSpanId()
    } : null

    if (this._currentLabels || this._labelStack.length > 0) {
      this._labelStack.push(this._currentLabels)
    }
    this.setLabels(labels)
  }

  _exit () {
    if (!this._setLabels) return

    this.setLabels(this._labelStack.pop())
  }

  profile () {
    if (!this._stop) return
    return this._stop(true)
  }

  encode (profile) {
    return this._pprof.encode(profile)
  }

  stop () {
    if (!this._stop) return
    this._stop()
    this._stop = undefined
    this._setLabels = undefined
    if (this._hotspots) {
      beforeCh.unsubscribe(this._enter)
      afterCh.unsubscribe(this._exit)
      incomingHttpRequestStart.unsubscribe(this._enter)
      incomingHttpRequestEnd.unsubscribe(this._exit)
      this.resetStack()
    }
  }

  _record () {
    if (this._hotspots) {
      const { stop, setLabels } = this._pprof.time.startWithLabels(
        this._samplingInterval, this._flushInterval, null, this._mapper, false)
      this._stop = stop
      this._setLabels = setLabels
    } else {
      this._stop = this._pprof.time.start(
        this._samplingInterval, null, this._mapper, false)
      this._setLabels = undefined
    }
  }
}

module.exports = NativeWallProfiler
