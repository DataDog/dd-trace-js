'use strict'

const opentracing = require('opentracing')
const Span = opentracing.Span
const truncate = require('lodash.truncate')
const SpanContext = require('./span_context')
const platform = require('../platform')
const log = require('../log')
const constants = require('../constants')

const SAMPLE_RATE_METRIC_KEY = constants.SAMPLE_RATE_METRIC_KEY

class DatadogSpan extends Span {
  constructor (tracer, recorder, sampler, prioritySampler, fields) {
    super()

    const startTime = fields.startTime || platform.now()
    const operationName = fields.operationName
    const parent = fields.parent || null
    const tags = Object.assign({}, fields.tags)
    const metrics = {
      [SAMPLE_RATE_METRIC_KEY]: sampler.rate()
    }

    this._parentTracer = tracer
    this._sampler = sampler
    this._recorder = recorder
    this._prioritySampler = prioritySampler
    this._startTime = startTime

    this._spanContext = this._createContext(parent)
    this._spanContext._name = operationName
    this._spanContext._tags = tags
    this._spanContext._metrics = metrics
  }

  toString () {
    const spanContext = this.context()
    const json = JSON.stringify({
      traceId: spanContext._traceId,
      spanId: spanContext._spanId,
      parentId: spanContext._parentId,
      service: spanContext._tags['service.name'],
      name: spanContext._name,
      resource: truncate(spanContext._tags['resource.name'], { length: 100 })
    })

    return `Span${json}`
  }

  _createContext (parent) {
    let spanContext

    if (parent) {
      const trace = parent._trace
      const finished = trace.started.length === trace.finished.length

      spanContext = new SpanContext({
        traceId: parent._traceId,
        spanId: platform.id(),
        parentId: parent._spanId,
        sampled: parent._sampled,
        sampling: parent._sampling,
        baggageItems: parent._baggageItems,
        trace: {
          started: finished ? [] : trace.started,
          finished: finished ? [] : trace.finished,
          origin: trace.origin
        }
      })
    } else {
      const spanId = platform.id()
      spanContext = new SpanContext({
        traceId: spanId,
        spanId,
        sampled: this._sampler.isSampled(this)
      })
    }

    spanContext._trace.started.push(this)

    return spanContext
  }

  _context () {
    return this._spanContext
  }

  _tracer () {
    return this._parentTracer
  }

  _setOperationName (name) {
    this._spanContext._name = name
  }

  _setBaggageItem (key, value) {
    this._spanContext._baggageItems[key] = value
  }

  _getBaggageItem (key) {
    return this._spanContext._baggageItems[key]
  }

  _addTags (keyValuePairs) {
    try {
      Object.keys(keyValuePairs).forEach(key => {
        this._spanContext._tags[key] = String(keyValuePairs[key])
      })
    } catch (e) {
      log.error(e)
    }
  }

  _finish (finishTime) {
    if (this._duration !== undefined) {
      return
    }

    finishTime = parseFloat(finishTime) || platform.now()

    this._duration = finishTime - this._startTime
    this._spanContext._trace.finished.push(this)
    this._spanContext._isFinished = true
    this._prioritySampler.sample(this)

    if (this._spanContext._sampled) {
      this._recorder.record(this)
    }

    this._spanContext._children
      .filter(child => !child.context()._isFinished)
      .forEach(child => {
        log.error(`Parent span ${this} was finished before child span ${child}.`)
      })
  }
}

module.exports = DatadogSpan
