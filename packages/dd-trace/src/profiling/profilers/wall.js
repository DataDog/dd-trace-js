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
    this._samplingInterval = options.samplingInterval || 1e6 / 99 // 99hz
    this._flushInterval = options.flushInterval || 60 * 1000 // 60 seconds
    this._mapper = undefined
    this._pprof = undefined

    // Bind to this so the same value can be used to unsubscribe later
    this._enter = this._enter.bind(this)
    this._exit = this._exit.bind(this)
  }

  resetStack () {
    this._currentSpan = undefined
    this._currentLabels = undefined
    this._spanStack = []
    this._labelStack = []
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

    this.resetStack()
    this._record()
    this._enter()
    beforeCh.subscribe(this._enter)
    afterCh.subscribe(this._exit)
    incomingHttpRequestStart.subscribe(this._enter)
    incomingHttpRequestEnd.subscribe(this._exit)
  }

  markAsSampled (span) {
    // NOTE: there's no guarantee these tags will be applied to the span as it
    // is possible it'll be sent to the agent by the time we get to execute
    // this code.
    if (span && this._labelsCaptured()) {
      span.setTag('sampled', 'yes')
      span.setTag('manual.keep', true)
    }
  }

  setLabels (labels) {
    this._currentLabels = labels
    this._setLabels(labels)
  }

  _enter () {
    if (!this._stop) return

    const lastSpan = this._currentSpan
    this.markAsSampled(lastSpan)
    // NOTE: We stack nulls/undefineds *except* at the bottom of the
    // stack, since pop() on an empty stack "synthesizes" those anyway.
    if (lastSpan || this._spanStack.length > 0) {
      this._spanStack.push(lastSpan)
    }

    const currentSpan = getActiveSpan() || null
    this._currentSpan = currentSpan

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
    if (!this._stop) return

    this.markAsSampled(this._currentSpan)
    this._currentSpan = this._spanStack.pop()
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
    beforeCh.unsubscribe(this._enter)
    afterCh.unsubscribe(this._exit)
    incomingHttpRequestStart.unsubscribe(this._enter)
    incomingHttpRequestEnd.unsubscribe(this._exit)
    this.resetStack()
  }

  _record () {
    const { stop, setLabels, labelsCaptured } = this._pprof.time.start(
      this._samplingInterval, this._flushInterval, null, this._mapper, false)
    this._stop = stop
    this._setLabels = setLabels
    this._labelsCaptured = labelsCaptured
  }
}

module.exports = NativeWallProfiler
