'use strict'

const { storage } = require('../../../../datadog-core')

const dc = require('../../../../diagnostics_channel')

const beforeCh = dc.channel('dd-trace:storage:before')
const afterCh = dc.channel('dd-trace:storage:after')
const enterCh = dc.channel('dd-trace:storage:enter')

function getActiveSpan () {
  const store = storage.getStore()
  if (!store) return
  return store.span
}

function getStartedSpans (context) {
  if (!context) return
  return context._trace.started
}

function getSpanContextTags (span) {
  return span.context()._tags
}

function isWebServerSpan (tags) {
  return tags['span.type'] === 'web'
}

function endpointNameFromTags (tags) {
  return tags['resource.name'] || [
    tags['http.method'],
    tags['http.route']
  ].filter(v => v).join(' ')
}

class NativeWallProfiler {
  constructor (options = {}) {
    this.type = 'wall'
    // input as micros, passed on as micros
    this._samplingIntervalMicros = options.samplingInterval || 1e6 / 99 // 99hz
    // input as millis, passed on as micros
    this._flushIntervalMillis = options.flushInterval || 60 * 1e3 // 60 seconds
    this._codeHotspotsEnabled = !!options.codeHotspotsEnabled
    this._endpointCollectionEnabled = !!options.endpointCollectionEnabled
    this._mapper = undefined
    this._pprof = undefined

    // Bind to this so the same value can be used to unsubscribe later
    this._enter = this._enter.bind(this)
    this._exit = this._exit.bind(this)
    this._logger = options.logger
    this._started = false
  }

  codeHotspotsEnabled () {
    return this._codeHotspotsEnabled
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

    this._pprof.time.start({
      intervalMicros: this._samplingIntervalMicros,
      durationMillis: this._flushIntervalMillis,
      sourceMapper: this._mapper,
      customLabels: this._codeHotspotsEnabled,
      lineNumbers: false })

    if (this._codeHotspotsEnabled) {
      beforeCh.subscribe(this._enter)
      enterCh.subscribe(this._enter)
      afterCh.subscribe(this._exit)
    }

    this._started = true
  }

  setLabels (labels) {
    this._pprof.time.setLabels(labels)
  }

  _enter () {
    if (!this._started) return

    const currentSpan = getActiveSpan() || null
    const currentContext = currentSpan ? currentSpan.context() : null

    if (!currentContext) return

    const startedSpans = getStartedSpans(currentContext)
    if (!startedSpans || startedSpans.length === 0) return
    const rootContext = startedSpans[0].context()
    if (!rootContext) return

    const labels = currentContext ? {
      'local root span id': rootContext.toSpanId(),
      'span id': currentContext.toSpanId()
    } : null

    if (this._endpointCollectionEnabled) {
      const webServerTags = startedSpans
        .map(getSpanContextTags)
        .filter(isWebServerSpan)[0]

      if (webServerTags) {
        labels['trace endpoint'] = endpointNameFromTags(webServerTags)
      }
    }

    this.setLabels(labels)
  }

  _exit () {
    if (!this._started) return
    this.setLabels(undefined)
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
      enterCh.unsubscribe(this._enter)
    }
    this._started = false
    return profile
  }
}

module.exports = NativeWallProfiler
