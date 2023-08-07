'use strict'

// TODO (new internal tracer): use DC events for lifecycle metrics and test them
const { performance } = require('perf_hooks')
const { channel } = require('../../../diagnostics_channel')
const now = performance.now.bind(performance)
const dateNow = Date.now
const semver = require('semver')
const SpanContext = require('./span_context')
const id = require('../id')
const tagger = require('../tagger')
const metrics = require('../metrics')
const log = require('../log')
const { storage } = require('../../../datadog-core')
const telemetryMetrics = require('../telemetry/metrics')

const tracerMetrics = telemetryMetrics.manager.namespace('tracers')

const {
  DD_TRACE_EXPERIMENTAL_STATE_TRACKING,
  DD_TRACE_EXPERIMENTAL_SPAN_COUNTS,
  DD_COLLECTOR_ENABLED
} = process.env

const startChannel = channel('datadog:tracing:span:start')
const tagsChannel = channel('datadog:tracing:span:tags')
const errorChannel = channel('datadog:tracing:span:error')
const finishChannel = channel('datadog:tracing:span:finish')

const unfinishedRegistry = createRegistry('unfinished')
const finishedRegistry = createRegistry('finished')

const OTEL_ENABLED = !!process.env.DD_TRACE_OTEL_ENABLED

const integrationCounters = {
  span_created: {},
  span_finished: {}
}

function getIntegrationCounter (event, integration) {
  const counters = integrationCounters[event]

  if (integration in counters) {
    return counters[integration]
  }

  const counter = tracerMetrics.count(event, [
    `integration_name:${integration.toLowerCase()}`,
    `otel_enabled:${OTEL_ENABLED}`
  ])

  integrationCounters[event][integration] = counter

  return counter
}

class DatadogSpan {
  constructor (tracer, processor, prioritySampler, fields, debug) {
    const operationName = fields.operationName
    const parent = fields.parent || null
    const tags = Object.assign({}, fields.tags)
    const hostname = fields.hostname

    this._parentTracer = tracer
    this._debug = debug
    this._store = storage.getStore()

    // For internal use only. You probably want `context()._name`.
    // This name property is not updated when the span name changes.
    // This is necessary for span count metrics.
    this._name = operationName
    this._integrationName = fields.integrationName || 'opentracing'

    getIntegrationCounter('span_created', this._integrationName).inc()

    this._spanContext = this._createContext(parent, fields)
    this._startTime = fields.startTime || this._getTime()

    if (DD_COLLECTOR_ENABLED !== 'false') {
      startChannel.publish({
        time: this._startTime * 1e6,
        traceId: this._spanContext._traceId,
        spanId: this._spanContext._spanId,
        parentId: this._spanContext._parentId,
        type: tags['span.type'],
        name: operationName,
        resource: tags['resource.name'],
        service: tags['service.name'],
        meta: tags,
        metrics: tags
      })
    } else {
      this._processor = processor
      this._prioritySampler = prioritySampler
      this._duration = undefined
      this._spanContext._name = operationName
      this._spanContext._tags = tags
      this._spanContext._hostname = hostname
      this._spanContext._trace.started.push(this)
    }

    if (DD_TRACE_EXPERIMENTAL_SPAN_COUNTS && finishedRegistry) {
      metrics.increment('runtime.node.spans.unfinished')
      metrics.increment('runtime.node.spans.unfinished.by.name', `span_name:${operationName}`)

      metrics.increment('runtime.node.spans.open') // unfinished for real
      metrics.increment('runtime.node.spans.open.by.name', `span_name:${operationName}`)

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

  context () {
    return this._spanContext
  }

  tracer () {
    return this._parentTracer
  }

  setOperationName (name) {
    this._spanContext._name = name
    return this
  }

  setBaggageItem (key, value) {
    this._spanContext._baggageItems[key] = value
    return this
  }

  getBaggageItem (key) {
    return this._spanContext._baggageItems[key]
  }

  setTag (key, value) {
    this._addTags({ [key]: value })
    return this
  }

  addTags (keyValueMap) {
    this._addTags(keyValueMap)
    return this
  }

  log () {
    return this
  }

  logEvent () {}

  finish (finishTime) {
    if (this._isFinished !== undefined) return

    this._spanContext._isFinished = true

    finishTime = parseFloat(finishTime) || this._getTime()

    if (DD_COLLECTOR_ENABLED !== 'false') {
      finishChannel.publish({
        time: finishTime * 1e6,
        traceId: this._spanContext._traceId,
        spanId: this._spanContext._spanId
      })
    } else {
      if (DD_TRACE_EXPERIMENTAL_STATE_TRACKING === 'true') {
        if (!this._spanContext._tags['service.name']) {
          log.error(`Finishing invalid span: ${this}`)
        }
      }

      this._duration = finishTime - this._startTime
      this._spanContext._trace.finished.push(this)
      this._processor.process(this)
    }

    getIntegrationCounter('span_finished', this._integrationName).inc()

    if (DD_TRACE_EXPERIMENTAL_SPAN_COUNTS && finishedRegistry) {
      metrics.decrement('runtime.node.spans.unfinished')
      metrics.decrement('runtime.node.spans.unfinished.by.name', `span_name:${this._name}`)
      metrics.increment('runtime.node.spans.finished')
      metrics.increment('runtime.node.spans.finished.by.name', `span_name:${this._name}`)

      metrics.decrement('runtime.node.spans.open') // unfinished for real
      metrics.decrement('runtime.node.spans.open.by.name', `span_name:${this._name}`)

      unfinishedRegistry.unregister(this)
      finishedRegistry.register(this, this._name)
    }
  }

  _createContext (parent, fields) {
    let spanContext
    let startTime

    if (fields.context) {
      spanContext = fields.context
      if (!spanContext._trace.startTime) {
        startTime = dateNow()
      }
    } else if (parent) {
      spanContext = new SpanContext({
        traceId: parent._traceId,
        spanId: id(),
        parentId: parent._spanId,
        sampling: parent._sampling,
        baggageItems: Object.assign({}, parent._baggageItems),
        trace: parent._trace,
        tracestate: parent._tracestate
      })

      if (!spanContext._trace.startTime) {
        startTime = dateNow()
      }
    } else {
      const spanId = id()
      startTime = dateNow()
      spanContext = new SpanContext({
        traceId: spanId,
        spanId
      })
      spanContext._trace.startTime = startTime

      if (fields.traceId128BitGenerationEnabled) {
        spanContext._trace.tags['_dd.p.tid'] = Math.floor(startTime / 1000).toString(16)
          .padStart(8, '0')
          .padEnd(16, '0')
      }
    }

    spanContext._trace.ticks = spanContext._trace.ticks || now()
    if (startTime) {
      spanContext._trace.startTime = startTime
    }

    return spanContext
  }

  _getTime () {
    const { startTime, ticks } = this._spanContext._trace

    return startTime + now() - ticks
  }

  _addTags (keyValuePairs) {
    if (!keyValuePairs) return

    if (DD_COLLECTOR_ENABLED !== 'false') {
      tagsChannel.publish({
        traceId: this._spanContext._traceId,
        spanId: this._spanContext._spanId,
        meta: keyValuePairs,
        metrics: keyValuePairs
      })

      if (keyValuePairs['error']) {
        errorChannel.publish({
          traceId: this._spanContext._traceId,
          spanId: this._spanContext._spanId,
          error: keyValuePairs['error']
        })
      }
    } else {
      if (keyValuePairs['span.name']) {
        this._spanContext._name = keyValuePairs['span.name']
      }

      tagger.add(this._spanContext._tags, keyValuePairs)

      this._prioritySampler.sample(this, false)
    }
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
