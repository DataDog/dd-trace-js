'use strict'

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
      resource: span.resource || span.name,
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

    this._setMeta(spanData, 'service', this._config.service)
    this._setMeta(spanData, 'env', this._config.env)
    this._setMeta(spanData, 'version', this._config.version)
    this._setMeta(spanData, 'runtime-id', runtimeId)
    this._setMeta(spanData, 'span.kind', span.kind)
    this._setMeta(spanData, '_dd.origin', span.trace.origin)
    this._setMeta(spanData, '_dd.hostname', this._config.hostname)

    if (error && typeof error === 'object') {
      this._setMeta(spanData, 'error.type', error.name)
      this._setMeta(spanData, 'error.msg', error.message)
      this._setMeta(spanData, 'error.stack', error.stack)

      for (const key in error) {
        this._setMeta(spanData, `error.${key}`, error[key])
      }
    }

    if (span.service === span.tracer.config.service) {
      this._setMeta(spanData, 'language', 'javascript')
    }

    this._addMeta(spanData, span.tracer.config.meta)
    this._addMeta(spanData, span.meta)

    if (span === span.trace.spans[0]) {
      this._addMeta(spanData, span.trace.meta)
    }
  }

  _extractMetrics (spanData, span) {
    const measured = span.measured || span.kind !== 'internal'

    this._setMetric(spanData, '_sampling_priority_v1', span.trace.samplingPriority)
    this._setMetric(spanData, '_dd.measured', measured ? 1 : 0)
    this._addMetrics(spanData, span.tracer.config.metrics)
    this._addMetrics(spanData, span.metrics)

    if (span === span.trace.spans[0]) {
      this._addMetrics(spanData, span.trace.metrics)
    }
  }

  _setMeta (spanData, key, value) {
    if (value !== null || value !== undefined || value !== '') {
      spanData.meta[key] = value
    }
  }

  _addMeta (spanData, meta) {
    for (const key in meta) {
      this._setMeta(spanData, key, meta[key])
    }
  }

  _setMetric (spanData, key, value) {
    if (typeof value === 'number') {
      spanData.meta[key] = value
    }
  }

  _addMetrics (spanData, metrics) {
    for (const key in metrics) {
      this._setMetric(spanData, key, metrics[key])
    }
  }
}

module.exports = { Formatter }
