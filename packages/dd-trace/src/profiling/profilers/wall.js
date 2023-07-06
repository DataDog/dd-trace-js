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
    this._samplingIntervalMicros = options.samplingInterval || 1e6 / 99 // 99hz
    // input as millis, passed on as micros
    this._flushIntervalMillis = options.flushInterval || 60 * 1e3 // 60 seconds
    this._codeHotspotsEnabled = !!options.codeHotspotsEnabled
    this._mapper = undefined
    this._pprof = undefined

    // Bind to this so the same value can be used to unsubscribe later
    this._enter = this._enter.bind(this)
    this._exit = this._exit.bind(this)
    this._logger = options.logger
    this._started = false
  }

  resetStack () {
    this._currentLabels = undefined
    this._labelStack = []
  }

  start ({ mapper } = {}) {
    if (this._started) return

    if (this._codeHotspotsEnabled && !this._emittedFFMessage && this._logger) {
      this._logger.debug(
        'Wall profiler: Enable config_trace_show_breakdown_profiling_for_node feature flag to see code hotspots.')
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
    this._pprof.time.start({
      intervalMicros: this._samplingIntervalMicros,
      durationMillis: this._flushIntervalMillis,
      sourceMapper: this._mapper,
      customLabels: this._codeHotspotsEnabled,
      lineNumbers: false })

    if (this._codeHotspotsEnabled) {
      beforeCh.subscribe(this._enter)
      afterCh.subscribe(this._exit)
      incomingHttpRequestStart.subscribe(this._enter)
      incomingHttpRequestEnd.subscribe(this._exit)
    }

    this._started = true
  }

  setLabels (labels) {
    this._pprof.time.setLabels(labels)
  }

  _enter () {
    if (!this._started) return

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
    if (!this._started) return
    this.setLabels(this._labelStack.pop())
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
    if (this._codeHotspotsEnabled) {
      beforeCh.unsubscribe(this._enter)
      afterCh.unsubscribe(this._exit)
      incomingHttpRequestStart.unsubscribe(this._enter)
      incomingHttpRequestEnd.unsubscribe(this._exit)
      this.resetStack()
    }
    this._started = false
    return profile
  }
}

module.exports = NativeWallProfiler
