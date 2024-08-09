'use strict'

const { channel } = require('dc-polyfill')
const DatadogSpan = require('../opentracing/span')
const DatadogCollectorSpanContext = require('./span_context')

const now = performance.now.bind(performance)

const startSegmentChannel = channel('datadog:tracing:segment:start')
const segmentDiscardChannel = channel('datadog:tracing:segment:discard')
const startChannel = channel('datadog:tracing:span:start')
const tagsChannel = channel('datadog:tracing:span:tags')
const errorChannel = channel('datadog:tracing:span:error')
const finishChannel = channel('datadog:tracing:span:finish')

let segmentId = 0

class DatadogCollectorSpan extends DatadogSpan {
  finish (finishTime) {
    if (this._spanContext._isFinished) return

    this._spanContext._isFinished = true
    this._spanContext._trace.active--

    const trace = this._spanContext._trace

    // TODO: Emit a discard event from tracer. For now we just short-circuit.
    if (trace.isDiscarded) return
    if (trace.isRecording === false) {
      trace.isDiscarded = true
      return segmentDiscardChannel.publish({ segmentId })
    }

    const ticks = finishTime
      ? now() + finishTime - trace.ticks - trace.startTime
      : now() - trace.ticks

    finishChannel.publish({
      ticks,
      segmentId: trace.segmentId,
      spanIndex: this._spanContext._spanIndex
    })
  }

  _start (_tracer, _processor, _prioritySampler, fields, _debug) {
    const parent = fields.parent || null
    const tags = fields.tags || {}
    const spanContext = this._spanContext
    const trace = spanContext._trace

    this._trackSegment()

    spanContext._spanIndex = trace.lastIndex++

    if (parent && trace.segmentId === parent.segmentId) {
      spanContext._parentIndex = parent._spanIndex >= 0
        ? parent._spanIndex + 1
        : 0
    }

    startChannel.publish({
      ticks: now() - spanContext._trace.ticks,
      segmentId: spanContext._trace.segmentId,
      spanId: spanContext._spanId,
      parentIndex: spanContext._parentIndex,
      type: tags['span.type'],
      name: fields.operationName,
      resource: tags['resource.name'],
      service: tags['service.name'],
      meta: tags,
      metrics: tags
    })
  }

  _addTags (keyValuePairs = {}) {
    tagsChannel.publish({
      segmentId: this._spanContext._trace.segmentId,
      spanIndex: this._spanContext._spanIndex,
      meta: keyValuePairs,
      metrics: keyValuePairs
    })

    if (keyValuePairs.error) {
      errorChannel.publish({
        segmentId: this._spanContext._trace.segmentId,
        spanIndex: this._spanContext._spanIndex,
        error: keyValuePairs.error
      })
    }
  }

  _trackSegment () {
    const spanContext = this._spanContext
    const trace = spanContext._trace

    if (trace.active > 0) {
      trace.active++
    } else {
      const traceId = spanContext._traceId
      const parentId = spanContext._parentId
      const time = trace.startTime // TODO: update time on new segment

      trace.active = 1
      trace.lastIndex = 0
      trace.segmentId = ++segmentId

      startSegmentChannel.publish({ parentId, segmentId, time, traceId })
    }

    spanContext.segmentId = trace.segmentId
  }

  _initContext (props) {
    return new DatadogCollectorSpanContext(props)
  }
}

module.exports = DatadogCollectorSpan
