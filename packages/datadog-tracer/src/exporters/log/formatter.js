'use strict'

const { addTags, setTag } = require('../../util')
const { runtimeId } = require('../../../../datadog-core')

class Formatter {
  constructor (config) {
    this._config = config
  }

  format (span) {
    const spanData = {
      trace_id: span.traceId,
      span_id: span.spanId,
      parent_id: span.parentId,
      name: span.name,
      resource: span.resource,
      service: span.service,
      type: span.type,
      error: span.error ? 1 : 0,
      start: span.start,
      duration: span.duration,
      meta: {},
      metrics: {}
    }

    this._extractMeta(spanData, span)
    this._extractMetrics(spanData, span)

    return spanData
  }

  _extractMeta (spanData, span) {
    const error = span.error

    setTag(spanData, 'service', this._config.service)
    setTag(spanData, 'env', this._config.env)
    setTag(spanData, 'version', this._config.version)
    setTag(spanData, 'runtime-id', runtimeId)
    setTag(spanData, 'span.kind', span.kind)
    setTag(spanData, '_dd.origin', span.trace.origin)
    setTag(spanData, '_dd.hostname', this._config.hostname)

    if (error && typeof error === 'object') {
      setTag(spanData, 'error.type', error.name)
      setTag(spanData, 'error.msg', error.message)
      setTag(spanData, 'error.stack', error.stack)
      addTags(spanData, error, 'error.')
    }

    if (span.service === span.tracer.config.service) {
      setTag(spanData, 'language', 'javascript')
    }

    addTags(spanData, span.tracer.config.meta)
    addTags(spanData, span.meta)

    if (span === span.trace.spans[0]) {
      addTags(spanData, span.trace.meta)
    }
  }

  _extractMetrics (spanData, span) {
    const measured = span.measured || span.kind !== 'internal'

    setTag(spanData, '_sampling_priority_v1', span.trace.samplingPriority)
    setTag(spanData, '_dd.measured', measured ? 1 : 0)
    addTags(span.tracer.config.metrics)
    addTags(span.metrics)

    if (span === span.trace.spans[0]) {
      addTags(span.trace.metrics)
    }
  }
}

module.exports = { Formatter }
