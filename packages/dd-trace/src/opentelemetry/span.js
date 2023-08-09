'use strict'

const api = require('@opentelemetry/api')

const { performance } = require('perf_hooks')
const { timeOrigin } = performance

const { timeInputToHrTime } = require('@opentelemetry/core')

const tracer = require('../../')
const DatadogSpan = require('../opentracing/span')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../constants')
const { SERVICE_NAME, RESOURCE_NAME } = require('../../../../ext/tags')

const SpanContext = require('./span_context')

// The one built into OTel rounds so we lose sub-millisecond precision.
function hrTimeToMilliseconds (time) {
  return time[0] * 1e3 + time[1] / 1e6
}

class Span {
  constructor (
    parentTracer,
    context,
    spanName,
    spanContext,
    kind,
    links = [],
    timeInput
  ) {
    const { _tracer } = tracer

    const hrStartTime = timeInputToHrTime(timeInput || (performance.now() + timeOrigin))
    const startTime = hrTimeToMilliseconds(hrStartTime)

    this._ddSpan = new DatadogSpan(_tracer, _tracer._processor, _tracer._prioritySampler, {
      operationName: spanName,
      context: spanContext._ddContext,
      startTime,
      hostname: _tracer._hostname,
      integrationName: 'otel',
      tags: {
        [SERVICE_NAME]: _tracer._service,
        [RESOURCE_NAME]: spanName
      }
    }, _tracer._debug)

    this._parentTracer = parentTracer
    this._context = context

    this._hasStatus = false

    // NOTE: Need to grab the value before setting it on the span because the
    // math for computing opentracing timestamps is apparently lossy...
    this.startTime = hrStartTime
    this.kind = kind
    this.links = links
    this._spanProcessor.onStart(this, context)
  }

  get parentSpanId () {
    const { _parentId } = this._ddSpan.context()
    return _parentId && _parentId.toString(16)
  }

  // Expected by OTel
  get resource () {
    return this._parentTracer.resource
  }
  get instrumentationLibrary () {
    return this._parentTracer.instrumentationLibrary
  }
  get _spanProcessor () {
    return this._parentTracer.getActiveSpanProcessor()
  }

  get name () {
    return this._ddSpan.context()._name
  }

  spanContext () {
    return new SpanContext(this._ddSpan.context())
  }

  setAttribute (key, value) {
    this._ddSpan.setTag(key, value)
    return this
  }

  setAttributes (attributes) {
    this._ddSpan.addTags(attributes)
    return this
  }

  addEvent (name, attributesOrStartTime, startTime) {
    api.diag.warn('Events not supported')
    return this
  }

  setStatus ({ code, message }) {
    if (!this.ended && !this._hasStatus && code) {
      this._hasStatus = true
      if (code === 2) {
        this._ddSpan.addTags({
          [ERROR_MESSAGE]: message
        })
      }
    }
    return this
  }

  updateName (name) {
    if (!this.ended) {
      this._ddSpan.setOperationName(name)
    }
    return this
  }

  end (timeInput) {
    if (this.ended) {
      api.diag.error('You can only call end() on a span once.')
      return
    }

    const hrEndTime = timeInputToHrTime(timeInput || (performance.now() + timeOrigin))
    const endTime = hrTimeToMilliseconds(hrEndTime)

    this._ddSpan.finish(endTime)
    this._spanProcessor.onEnd(this)
  }

  isRecording () {
    return this.ended === false
  }

  recordException (exception) {
    this._ddSpan.addTags({
      [ERROR_TYPE]: exception.name,
      [ERROR_MESSAGE]: exception.message,
      [ERROR_STACK]: exception.stack
    })
  }

  get duration () {
    return this._ddSpan._duration
  }

  get ended () {
    return typeof this.duration !== 'undefined'
  }
}

module.exports = Span
