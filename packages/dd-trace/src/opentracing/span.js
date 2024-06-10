'use strict'

// TODO (new internal tracer): use DC events for lifecycle metrics and test them
const { performance } = require('perf_hooks')
const now = performance.now.bind(performance)
const dateNow = Date.now
const semver = require('semver')
const SpanContext = require('./span_context')
const id = require('../id')
const tagger = require('../tagger')
const runtimeMetrics = require('../runtime_metrics')
const log = require('../log')
const { storage } = require('../../../datadog-core')
const telemetryMetrics = require('../telemetry/metrics')
const { channel } = require('dc-polyfill')
const spanleak = require('../spanleak')

const tracerMetrics = telemetryMetrics.manager.namespace('tracers')

const {
  DD_TRACE_EXPERIMENTAL_STATE_TRACKING,
  DD_TRACE_EXPERIMENTAL_SPAN_COUNTS
} = process.env

const unfinishedRegistry = createRegistry('unfinished')
const finishedRegistry = createRegistry('finished')

const OTEL_ENABLED = !!process.env.DD_TRACE_OTEL_ENABLED
const ALLOWED = ['string', 'number', 'boolean']

const integrationCounters = {
  spans_created: {},
  spans_finished: {}
}

const startCh = channel('dd-trace:span:start')
const finishCh = channel('dd-trace:span:finish')

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
    this._processor = processor
    this._prioritySampler = prioritySampler
    this._store = storage.getStore()
    this._duration = undefined

    this._events = []

    // For internal use only. You probably want `context()._name`.
    // This name property is not updated when the span name changes.
    // This is necessary for span count metrics.
    this._name = operationName
    this._integrationName = fields.integrationName || 'opentracing'

    getIntegrationCounter('spans_created', this._integrationName).inc()

    this._spanContext = this._createContext(parent, fields)
    this._spanContext._name = operationName
    this._spanContext._tags = tags
    this._spanContext._hostname = hostname

    this._spanContext._trace.started.push(this)

    this._startTime = fields.startTime || this._getTime()

    this._links = []
    fields.links && fields.links.forEach(link => this.addLink(link.context, link.attributes))

    if (DD_TRACE_EXPERIMENTAL_SPAN_COUNTS && finishedRegistry) {
      runtimeMetrics.increment('runtime.node.spans.unfinished')
      runtimeMetrics.increment('runtime.node.spans.unfinished.by.name', `span_name:${operationName}`)

      runtimeMetrics.increment('runtime.node.spans.open') // unfinished for real
      runtimeMetrics.increment('runtime.node.spans.open.by.name', `span_name:${operationName}`)

      unfinishedRegistry.register(this, operationName, this)
    }
    spanleak.addSpan(this, operationName)
    startCh.publish(this)
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

  addLink (context, attributes) {
    this._links.push({
      context: context._ddContext ? context._ddContext : context,
      attributes: this._sanitizeAttributes(attributes)
    })
  }

  addEvent (name, attributesOrStartTime, startTime) {
    const event = { name }
    if (attributesOrStartTime) {
      if (typeof attributesOrStartTime === 'object') {
        event.attributes = this._sanitizeEventAttributes(attributesOrStartTime)
      } else {
        startTime = attributesOrStartTime
      }
    }
    event.startTime = startTime || this._getTime()
    this._events.push(event)
  }

  finish (finishTime) {
    if (this._duration !== undefined) {
      return
    }

    if (DD_TRACE_EXPERIMENTAL_STATE_TRACKING === 'true') {
      if (!this._spanContext._tags['service.name']) {
        log.error(`Finishing invalid span: ${this}`)
      }
    }

    getIntegrationCounter('spans_finished', this._integrationName).inc()

    if (DD_TRACE_EXPERIMENTAL_SPAN_COUNTS && finishedRegistry) {
      runtimeMetrics.decrement('runtime.node.spans.unfinished')
      runtimeMetrics.decrement('runtime.node.spans.unfinished.by.name', `span_name:${this._name}`)
      runtimeMetrics.increment('runtime.node.spans.finished')
      runtimeMetrics.increment('runtime.node.spans.finished.by.name', `span_name:${this._name}`)

      runtimeMetrics.decrement('runtime.node.spans.open') // unfinished for real
      runtimeMetrics.decrement('runtime.node.spans.open.by.name', `span_name:${this._name}`)

      unfinishedRegistry.unregister(this)
      finishedRegistry.register(this, this._name)
    }

    finishTime = parseFloat(finishTime) || this._getTime()

    this._duration = finishTime - this._startTime
    this._spanContext._trace.finished.push(this)
    this._spanContext._isFinished = true
    finishCh.publish(this)
    this._processor.process(this)
  }

  _sanitizeAttributes (attributes = {}) {
    const sanitizedAttributes = {}

    const addArrayOrScalarAttributes = (key, maybeArray) => {
      if (Array.isArray(maybeArray)) {
        for (const subkey in maybeArray) {
          addArrayOrScalarAttributes(`${key}.${subkey}`, maybeArray[subkey])
        }
      } else {
        const maybeScalar = maybeArray
        if (ALLOWED.includes(typeof maybeScalar)) {
          // Wrap the value as a string if it's not already a string
          sanitizedAttributes[key] = typeof maybeScalar === 'string' ? maybeScalar : String(maybeScalar)
        } else {
          log.warn('Dropping span link attribute. It is not of an allowed type')
        }
      }
    }

    Object.entries(attributes).forEach(entry => {
      const [key, value] = entry
      addArrayOrScalarAttributes(key, value)
    })
    return sanitizedAttributes
  }

  _sanitizeEventAttributes (attributes = {}) {
    const sanitizedAttributes = {}

    for (const key in attributes) {
      const value = attributes[key]
      if (Array.isArray(value)) {
        const newArray = []
        for (const subkey in value) {
          if (ALLOWED.includes(typeof value[subkey])) {
            newArray.push(value[subkey])
          } else {
            log.warn('Dropping span event attribute. It is not of an allowed type')
          }
        }
        sanitizedAttributes[key] = newArray
      } else if (ALLOWED.includes(typeof value)) {
        sanitizedAttributes[key] = value
      } else {
        log.warn('Dropping span event attribute. It is not of an allowed type')
      }
    }
    return sanitizedAttributes
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
    // SpanContext was NOT propagated from a remote parent
    spanContext._isRemote = false

    return spanContext
  }

  _getTime () {
    const { startTime, ticks } = this._spanContext._trace

    return startTime + now() - ticks
  }

  _addTags (keyValuePairs) {
    tagger.add(this._spanContext._tags, keyValuePairs)

    this._prioritySampler.sample(this, false)
  }
}

function createRegistry (type) {
  if (!semver.satisfies(process.version, '>=14.6')) return

  return new global.FinalizationRegistry(name => {
    runtimeMetrics.decrement(`runtime.node.spans.${type}`)
    runtimeMetrics.decrement(`runtime.node.spans.${type}.by.name`, [`span_name:${name}`])
  })
}

module.exports = DatadogSpan
