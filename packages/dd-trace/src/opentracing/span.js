'use strict'

// TODO (new internal tracer): use DC events for lifecycle metrics and test them
const opentracing = require('opentracing')
const now = require('perf_hooks').performance.now
const dateNow = Date.now
const semver = require('semver')
const Span = opentracing.Span
const SpanContext = require('./span_context')
const id = require('../id')
const tagger = require('../tagger')
const metrics = require('../metrics')
const log = require('../log')
const { storage } = require('../../../datadog-core')

const {
  DD_TRACE_EXPERIMENTAL_STATE_TRACKING,
  DD_TRACE_EXPERIMENTAL_SPAN_COUNTS
} = process.env

const unfinishedRegistry = createRegistry('unfinished')
const finishedRegistry = createRegistry('finished')

class DatadogSpan extends Span {
  constructor (tracer, processor, prioritySampler, fields, debug) {
    super()

    const operationName = fields.operationName
    const parent = fields.parent || null
    const tags = Object.assign({}, fields.tags)
    const hostname = fields.hostname

    this._parentTracer = tracer
    this._debug = debug
    this._processor = processor
    this._prioritySampler = prioritySampler
    this._store = storage.getStore()
    this._name = operationName

    this._spanContext = this._createContext(parent)
    this._spanContext._name = operationName
    this._spanContext._tags = tags
    this._spanContext._hostname = hostname

    this._startTime = fields.startTime || this._getTime()

    if (DD_TRACE_EXPERIMENTAL_SPAN_COUNTS && finishedRegistry) {
      metrics.increment('runtime.node.spans.unfinished')
      metrics.increment('runtime.node.spans.unfinished.by.name', `span_name:${operationName}`)

      unfinishedRegistry.register(this, operationName, this)
    }
  }

  toString () {
    const spanContext = this.context()
    const resourceName = spanContext._tags['resource.name']
    const resource = resourceName.length > 100
      ? `${resourceName.substring(0, 97)}...`
      : resourceName
    const json = JSON.stringify({
      traceId: spanContext._traceId,
      spanId: spanContext._spanId,
      parentId: spanContext._parentId,
      service: spanContext._tags['service.name'],
      name: spanContext._name,
      resource
    })

    return `Span${json}`
  }

  _createContext (parent) {
    let spanContext

    if (parent) {
      spanContext = new SpanContext({
        traceId: parent._traceId,
        spanId: id(),
        parentId: parent._spanId,
        sampling: parent._sampling,
        baggageItems: Object.assign({}, parent._baggageItems),
        trace: parent._trace
      })
    } else {
      const spanId = id()
      spanContext = new SpanContext({
        traceId: spanId,
        spanId
      })
    }

    spanContext._trace.started.push(this)
    spanContext._trace.startTime = spanContext._trace.startTime || dateNow()
    spanContext._trace.ticks = spanContext._trace.ticks || now()

    return spanContext
  }

  _getTime () {
    const { startTime, ticks } = this._spanContext._trace

    return startTime + now() - ticks
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
    tagger.add(this._spanContext._tags, keyValuePairs)

    this._prioritySampler.sample(this, false)
  }

  _finish (finishTime) {
    if (this._duration !== undefined) {
      return
    }

    if (DD_TRACE_EXPERIMENTAL_STATE_TRACKING === 'true') {
      if (!this._spanContext._tags['service.name']) {
        log.error(`Finishing invalid span: ${this}`)
      }
    }

    if (DD_TRACE_EXPERIMENTAL_SPAN_COUNTS && finishedRegistry) {
      metrics.decrement('runtime.node.spans.unfinished')
      metrics.decrement('runtime.node.spans.unfinished.by.name', `span_name:${this._name}`)
      metrics.increment('runtime.node.spans.finished')
      metrics.increment('runtime.node.spans.finished.by.name', `span_name:${this._name}`)

      unfinishedRegistry.unregister(this)
      finishedRegistry.register(this, this._name)
    }

    finishTime = parseFloat(finishTime) || this._getTime()

    this._duration = finishTime - this._startTime
    this._spanContext._trace.finished.push(this)
    this._spanContext._isFinished = true
    this._processor.process(this)
  }
}

function createRegistry (type) {
  if (!semver.satisfies(process.version, '>=14.6')) return

  return new global.FinalizationRegistry(name => {
    metrics.decrement(`runtime.node.spans.${type}`)
    metrics.decrement(`runtime.node.spans.${type}.by.name`, [`span_name:${name}`])
  })
}

module.exports = DatadogSpan
