'use strict'

const { storage } = require('../../../../datadog-core')

const dc = require('diagnostics_channel')

const beforeCh = dc.channel('dd-trace:storage:before')
const afterCh = dc.channel('dd-trace:storage:after')

function getActiveSpan () {
  const store = storage.getStore()
  if (!store) return
  return store.span
}

function getStartedSpans (activeSpan) {
  const context = activeSpan.context()
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

class NativeCpuProfiler {
  constructor (options = {}) {
    this.type = 'cpu'
    this._frequency = options.frequency || 99
    this._mapper = undefined
    this._pprof = undefined
    this._started = false
    this._cpuProfiler = undefined
    this._endpointCollection = options.endpointCollection

    // Bind to this so the same value can be used to unsubscribe later
    this._enter = this._enter.bind(this)
    this._exit = this._exit.bind(this)
  }

  _enter () {
    if (!this._cpuProfiler) return

    const active = getActiveSpan()
    if (!active) return

    const activeCtx = active.context()
    if (!activeCtx) return

    const spans = getStartedSpans(active)
    if (!spans || !spans.length) return

    const firstCtx = spans[0].context()
    if (!firstCtx) return

    const labels = {
      'local root span id': firstCtx.toSpanId(),
      'span id': activeCtx.toSpanId()
    }

    if (this._endpointCollection) {
      const webServerTags = spans
        .map(getSpanContextTags)
        .filter(isWebServerSpan)[0]

      if (webServerTags) {
        labels['trace endpoint'] = endpointNameFromTags(webServerTags)
      }
    }

    this._cpuProfiler.labels = labels
  }

  _exit () {
    if (!this._cpuProfiler) return
    this._cpuProfiler.labels = {}
  }

  start ({ mapper } = {}) {
    if (this._started) return
    this._started = true

    this._mapper = mapper
    if (!this._pprof) {
      this._pprof = require('@datadog/pprof')
      this._cpuProfiler = new this._pprof.CpuProfiler()
    }

    this._cpuProfiler.start(this._frequency)

    this._enter()
    beforeCh.subscribe(this._enter)
    afterCh.subscribe(this._exit)
  }

  profile () {
    if (!this._started) return
    return this._cpuProfiler.profile()
  }

  encode (profile) {
    return this._pprof.encode(profile)
  }

  stop () {
    if (!this._started) return
    this._started = false

    this._cpuProfiler.stop()
    beforeCh.unsubscribe(this._enter)
    afterCh.unsubscribe(this._exit)
  }
}

module.exports = NativeCpuProfiler
