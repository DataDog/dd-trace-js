'use strict'

const { performance } = require('perf_hooks')
const now = performance.now.bind(performance)
const dateNow = Date.now

const DatadogSpan = require('../opentracing/span')
const DatadogSpanContext = require('../opentracing/span_context')
const NativeSpanContext = require('./span_context')
const { OpCode } = require('./index')
const id = require('../id')
const tagger = require('../tagger')
const runtimeMetrics = require('../runtime_metrics')
const log = require('../log')
const { storage } = require('../../../datadog-core')
const telemetryMetrics = require('../telemetry/metrics')
const { channel } = require('dc-polyfill')
const util = require('util')
const { getEnvironmentVariable } = require('../config-helper')

const tracerMetrics = telemetryMetrics.manager.namespace('tracers')

const DD_TRACE_EXPERIMENTAL_STATE_TRACKING = getEnvironmentVariable('DD_TRACE_EXPERIMENTAL_STATE_TRACKING')
const DD_TRACE_EXPERIMENTAL_SPAN_COUNTS = getEnvironmentVariable('DD_TRACE_EXPERIMENTAL_SPAN_COUNTS')

const OTEL_ENABLED = !!getEnvironmentVariable('DD_TRACE_OTEL_ENABLED')
const ALLOWED = new Set(['string', 'number', 'boolean'])

const integrationCounters = {
  spans_created: {},
  spans_finished: {}
}

const startCh = channel('dd-trace:span:start')
const finishCh = channel('dd-trace:span:finish')

// Registries for span leak detection (shared with base span)
let unfinishedRegistry = null
let finishedRegistry = null

if (DD_TRACE_EXPERIMENTAL_SPAN_COUNTS) {
  unfinishedRegistry = new global.FinalizationRegistry(name => {
    runtimeMetrics.decrement('runtime.node.spans.unfinished')
    runtimeMetrics.decrement('runtime.node.spans.unfinished.by.name', [`span_name:${name}`])
  })
  finishedRegistry = new global.FinalizationRegistry(name => {
    runtimeMetrics.decrement('runtime.node.spans.finished')
    runtimeMetrics.decrement('runtime.node.spans.finished.by.name', [`span_name:${name}`])
  })
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

/**
 * NativeDatadogSpan extends the span functionality to use native Rust storage.
 *
 * This class maintains the same interface as DatadogSpan but stores span data
 * in native storage via NativeSpansInterface for improved performance.
 *
 * Key differences from DatadogSpan:
 * - Uses NativeSpanContext instead of DatadogSpanContext
 * - Span data is queued to native storage via change buffer
 * - Export is handled by native TraceExporter
 */
class NativeDatadogSpan {
  /**
   * @param {Object} tracer - The parent tracer
   * @param {Object} processor - The span processor
   * @param {Object} prioritySampler - The priority sampler
   * @param {Object} fields - Span creation fields
   * @param {string} fields.operationName - Span name
   * @param {DatadogSpanContext|null} [fields.parent] - Parent span context
   * @param {Object} [fields.tags] - Initial tags
   * @param {number} [fields.startTime] - Start time in milliseconds
   * @param {string} [fields.hostname] - Hostname
   * @param {boolean} [fields.traceId128BitGenerationEnabled] - Whether to use 128-bit trace IDs
   * @param {string} [fields.integrationName] - Integration name
   * @param {Array} [fields.links] - Span links
   * @param {boolean} debug - Debug mode flag
   * @param {import('./native_spans')} nativeSpans - The NativeSpansInterface instance
   */
  constructor (tracer, processor, prioritySampler, fields, debug, nativeSpans) {
    const operationName = fields.operationName
    const parent = fields.parent || null
    const tags = { ...fields.tags }
    const hostname = fields.hostname

    this._parentTracer = tracer
    this._debug = debug
    this._processor = processor
    this._prioritySampler = prioritySampler
    this._nativeSpans = nativeSpans
    this._store = storage('legacy').getHandle()
    this._duration = undefined

    this._events = []

    // For internal use only. You probably want `context()._name`.
    this._name = operationName
    this._integrationName = fields.integrationName || 'opentracing'

    getIntegrationCounter('spans_created', this._integrationName).inc()

    // Create the span context with native backing
    this._spanContext = this.#createContext(parent, fields)
    this._spanContext._name = operationName
    this._spanContext._hostname = hostname

    // Queue the span name to native storage
    this._spanContext._syncNameToNative(operationName)

    // Add tags using setTag() to sync to native storage
    for (const [key, value] of Object.entries(tags)) {
      this._spanContext.setTag(key, value)
    }

    // Add to trace's started spans
    this._spanContext._trace.started.push(this)

    // Calculate start time
    this._startTime = fields.startTime || this.#getTime()

    // Queue start time to native storage (in nanoseconds)
    this._nativeSpans.queueOp(
      OpCode.SetStart,
      this._spanContext._nativeSpanId,
      ['i64', BigInt(Math.round(this._startTime * 1e6))]
    )

    // Handle span links
    this._links = fields.links?.map(link => ({
      context: link.context._ddContext ?? link.context,
      attributes: this.#sanitizeAttributes(link.attributes)
    })) ?? []

    // Span leak tracking
    if (DD_TRACE_EXPERIMENTAL_SPAN_COUNTS && finishedRegistry) {
      runtimeMetrics.increment('runtime.node.spans.unfinished')
      runtimeMetrics.increment('runtime.node.spans.unfinished.by.name', `span_name:${operationName}`)
      runtimeMetrics.increment('runtime.node.spans.open')
      runtimeMetrics.increment('runtime.node.spans.open.by.name', `span_name:${operationName}`)
      unfinishedRegistry.register(this, operationName, this)
    }

    // Span leak debug
    if (tracer?._config?.spanLeakDebug > 0) {
      require('../spanleak').addSpan(this, operationName)
    }

    // Publish span start event
    if (startCh.hasSubscribers) {
      startCh.publish({ span: this, fields })
    }
  }

  [util.inspect.custom] () {
    return {
      ...this,
      _parentTracer: `[${this._parentTracer.constructor.name}]`,
      _prioritySampler: `[${this._prioritySampler.constructor.name}]`,
      _processor: `[${this._processor.constructor.name}]`,
      _nativeSpans: '[NativeSpansInterface]'
    }
  }

  toString () {
    const spanContext = this.context()
    const resourceName = spanContext.getTag('resource.name') || ''
    const resource = resourceName.length > 100
      ? `${resourceName.slice(0, 97)}...`
      : resourceName
    const json = JSON.stringify({
      traceId: spanContext._traceId,
      spanId: spanContext._spanId,
      parentId: spanContext._parentId,
      service: spanContext.getTag('service.name'),
      name: spanContext._name,
      resource
    })

    return `NativeSpan${json}`
  }

  /**
   * @returns {NativeSpanContext}
   */
  context () {
    return this._spanContext
  }

  tracer () {
    return this._parentTracer
  }

  setOperationName (name) {
    this._spanContext._name = name
    this._spanContext._syncNameToNative(name)
    return this
  }

  setBaggageItem (key, value) {
    this._spanContext._baggageItems[key] = value
    return this
  }

  getBaggageItem (key) {
    return this._spanContext._baggageItems[key]
  }

  getAllBaggageItems () {
    return JSON.stringify(this._spanContext._baggageItems)
  }

  removeBaggageItem (key) {
    delete this._spanContext._baggageItems[key]
  }

  removeAllBaggageItems () {
    this._spanContext._baggageItems = {}
  }

  setTag (key, value) {
    this.#addTags({ [key]: value })
    return this
  }

  addTags (keyValueMap) {
    this.#addTags(keyValueMap)
    return this
  }

  log () {
    return this
  }

  logEvent () {}

  addLink (link, attrs) {
    // TODO: Remove this once we remove addLink(context, attrs) in v6.0.0
    if (link instanceof DatadogSpanContext || link instanceof NativeSpanContext) {
      link = { context: link, attributes: attrs ?? {} }
    }

    const { context, attributes } = link

    this._links.push({
      context: context._ddContext ?? context,
      attributes: this.#sanitizeAttributes(attributes)
    })
  }

  addLinks (links) {
    links.forEach(link => this.addLink(link))
    return this
  }

  addSpanPointer (ptrKind, ptrDir, ptrHash) {
    const zeroContext = new DatadogSpanContext({
      traceId: id('0'),
      spanId: id('0')
    })
    const attributes = {
      'ptr.kind': ptrKind,
      'ptr.dir': ptrDir,
      'ptr.hash': ptrHash,
      'link.kind': 'span-pointer'
    }
    this.addLink({ context: zeroContext, attributes })
  }

  addEvent (name, attributesOrStartTime, startTime) {
    const event = { name }
    if (attributesOrStartTime) {
      if (typeof attributesOrStartTime === 'object') {
        event.attributes = this.#sanitizeEventAttributes(attributesOrStartTime)
      } else {
        startTime = attributesOrStartTime
      }
    }
    event.startTime = startTime || this.#getTime()
    this._events.push(event)
  }

  finish (finishTime) {
    if (this._duration !== undefined) {
      return
    }

    if (DD_TRACE_EXPERIMENTAL_STATE_TRACKING === 'true' && !this._spanContext.getTag('service.name')) {
      log.error('Finishing invalid span: %s', this)
    }

    getIntegrationCounter('spans_finished', this._integrationName).inc()
    this._spanContext.setTag('_dd.integration', this._integrationName)

    // Span leak tracking
    if (DD_TRACE_EXPERIMENTAL_SPAN_COUNTS && finishedRegistry) {
      runtimeMetrics.decrement('runtime.node.spans.unfinished')
      runtimeMetrics.decrement('runtime.node.spans.unfinished.by.name', `span_name:${this._name}`)
      runtimeMetrics.increment('runtime.node.spans.finished')
      runtimeMetrics.increment('runtime.node.spans.finished.by.name', `span_name:${this._name}`)
      runtimeMetrics.decrement('runtime.node.spans.open')
      runtimeMetrics.decrement('runtime.node.spans.open.by.name', `span_name:${this._name}`)
      unfinishedRegistry.unregister(this)
      finishedRegistry.register(this, this._name)
    }

    finishTime = Number.parseFloat(finishTime) || this.#getTime()

    this._duration = finishTime - this._startTime

    // Serialize span links to _dd.span_links meta tag before export
    this.#serializeSpanLinks()

    // Serialize span events to native storage
    this.#serializeSpanEvents()

    // Queue duration to native storage (in nanoseconds)
    this._nativeSpans.queueOp(
      OpCode.SetDuration,
      this._spanContext._nativeSpanId,
      ['i64', BigInt(Math.round(this._duration * 1e6))]
    )

    this._spanContext._trace.finished.push(this)
    this._spanContext._isFinished = true

    // Publish span finish event
    finishCh.publish(this)

    // Process the span
    this._processor.process(this)
  }

  #sanitizeAttributes (attributes = {}) {
    const sanitizedAttributes = {}

    const addArrayOrScalarAttributes = (key, maybeArray) => {
      if (Array.isArray(maybeArray)) {
        for (const subkey in maybeArray) {
          addArrayOrScalarAttributes(`${key}.${subkey}`, maybeArray[subkey])
        }
      } else {
        const maybeScalar = maybeArray
        if (ALLOWED.has(typeof maybeScalar)) {
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

  #sanitizeEventAttributes (attributes = {}) {
    const sanitizedAttributes = {}

    for (const key in attributes) {
      const value = attributes[key]
      if (Array.isArray(value)) {
        const newArray = []
        for (const subkey in value) {
          if (ALLOWED.has(typeof value[subkey])) {
            newArray.push(value[subkey])
          } else {
            log.warn('Dropping span event attribute. It is not of an allowed type')
          }
        }
        sanitizedAttributes[key] = newArray
      } else if (ALLOWED.has(typeof value)) {
        sanitizedAttributes[key] = value
      } else {
        log.warn('Dropping span event attribute. It is not of an allowed type')
      }
    }
    return sanitizedAttributes
  }

  /**
   * Create a NativeSpanContext for this span.
   * @param {DatadogSpanContext|null} parent - Parent span context
   * @param {Object} fields - Span creation fields
   * @returns {NativeSpanContext}
   */
  #createContext (parent, fields) {
    let spanContext
    let startTime
    let traceIdHigh = 0n
    let traceIdLow
    let parentIdBigInt = 0n

    let baggage = {}
    if (parent && parent._isRemote && this._parentTracer?._config?.tracePropagationBehaviorExtract !== 'continue') {
      baggage = parent._baggageItems
      parent = null
    }

    if (fields.context) {
      // Use existing context (e.g., from OTel)
      // If it's already a NativeSpanContext, use it directly
      // Otherwise, create a NativeSpanContext with the same IDs
      const existingContext = fields.context
      if (existingContext._nativeSpanId !== undefined) {
        // Already a NativeSpanContext
        spanContext = existingContext
        if (!spanContext._trace.startTime) {
          startTime = dateNow()
        }
        return spanContext
      }

      // Create NativeSpanContext wrapping the existing context's data
      spanContext = new NativeSpanContext(this._nativeSpans, {
        traceId: existingContext._traceId,
        spanId: existingContext._spanId,
        parentId: existingContext._parentId,
        sampling: existingContext._sampling,
        baggageItems: { ...existingContext._baggageItems },
        tags: { ...existingContext._tags },
        trace: existingContext._trace,
        tracestate: existingContext._tracestate
      })

      if (!spanContext._trace.startTime) {
        startTime = dateNow()
      }

      // Convert trace ID to u128 (high, low)
      const traceIdBuffer = existingContext._traceId.toBuffer()
      if (traceIdBuffer.length > 8) {
        traceIdHigh = BigInt('0x' + Buffer.from(traceIdBuffer.slice(0, 8)).toString('hex'))
        traceIdLow = BigInt('0x' + Buffer.from(traceIdBuffer.slice(-8)).toString('hex'))
      } else {
        traceIdLow = existingContext._traceId.toBigInt()
      }

      if (existingContext._parentId) {
        parentIdBigInt = existingContext._parentId.toBigInt()
      }
    } else if (parent) {
      // Child span - inherit trace ID, generate new span ID
      const spanId = id()

      spanContext = new NativeSpanContext(this._nativeSpans, {
        traceId: parent._traceId,
        spanId,
        parentId: parent._spanId,
        sampling: parent._sampling,
        baggageItems: { ...parent._baggageItems },
        trace: parent._trace,
        tracestate: parent._tracestate
      })

      if (!spanContext._trace.startTime) {
        startTime = dateNow()
      }

      // Convert trace ID to u128 (high, low)
      const traceIdBuffer = parent._traceId.toBuffer()
      if (traceIdBuffer.length > 8) {
        // 128-bit trace ID
        traceIdHigh = BigInt('0x' + Buffer.from(traceIdBuffer.slice(0, 8)).toString('hex'))
        traceIdLow = BigInt('0x' + Buffer.from(traceIdBuffer.slice(-8)).toString('hex'))
      } else {
        traceIdLow = parent._traceId.toBigInt()
      }

      parentIdBigInt = parent._spanId.toBigInt()
    } else {
      // Root span - generate new trace ID and span ID
      const spanId = id()
      startTime = dateNow()

      spanContext = new NativeSpanContext(this._nativeSpans, {
        traceId: spanId,
        spanId
      })
      spanContext._trace.startTime = startTime

      // Handle 128-bit trace ID generation
      if (fields.traceId128BitGenerationEnabled) {
        const tidHex = Math.floor(startTime / 1000).toString(16)
          .padStart(8, '0')
          .padEnd(16, '0')
        spanContext._trace.tags['_dd.p.tid'] = tidHex
        traceIdHigh = BigInt('0x' + tidHex)
      }

      traceIdLow = spanId.toBigInt()

      if (this._parentTracer?._config?.tracePropagationBehaviorExtract === 'restart') {
        spanContext._baggageItems = baggage
      }
    }

    spanContext._trace.ticks = spanContext._trace.ticks || now()
    if (startTime) {
      spanContext._trace.startTime = startTime
    }
    spanContext._isRemote = false

    // Queue Create operation to native storage
    this._nativeSpans.queueOp(
      OpCode.Create,
      spanContext._nativeSpanId,
      ['u128', [traceIdHigh, traceIdLow]],
      ['u64', parentIdBigInt]
    )

    return spanContext
  }

  #getTime () {
    const { startTime, ticks } = this._spanContext._trace
    return startTime + now() - ticks
  }

  #addTags (keyValuePairs) {
    // Parse tags using tagger into a temp object, then use setTag() to sync to native
    const parsedTags = {}
    tagger.add(parsedTags, keyValuePairs)

    // Use Reflect.ownKeys to include both string and Symbol keys
    // Object.entries() skips Symbol keys which are used internally (e.g., IGNORE_OTEL_ERROR)
    for (const key of Reflect.ownKeys(parsedTags)) {
      this._spanContext.setTag(key, parsedTags[key])
    }
    this._prioritySampler.sample(this, false)
  }

  /**
   * Serialize span links to _dd.span_links meta tag.
   * This matches the format used in span_format.js extractSpanLinks().
   */
  #serializeSpanLinks () {
    if (!this._links?.length) {
      return
    }

    const links = this._links.map(link => {
      const { context, attributes } = link
      const formattedLink = {
        trace_id: context.toTraceId(true),
        span_id: context.toSpanId(true)
      }

      if (attributes && Object.keys(attributes).length > 0) {
        formattedLink.attributes = attributes
      }
      if (context?._sampling?.priority >= 0) {
        formattedLink.flags = context._sampling.priority > 0 ? 1 : 0
      }
      if (context?._tracestate) {
        formattedLink.tracestate = context._tracestate.toString()
      }

      return formattedLink
    })

    // Set as meta tag - this will sync to native storage via setTag()
    this._spanContext.setTag('_dd.span_links', JSON.stringify(links))
  }

  /**
   * Serialize span events to native storage.
   * Span events are stored as a special meta_struct field.
   * This matches the format used in span_format.js extractSpanEvents().
   */
  #serializeSpanEvents () {
    if (!this._events?.length) {
      return
    }

    const events = this._events.map(event => {
      const formatted = {
        name: event.name,
        time_unix_nano: Math.round(event.startTime * 1e6)
      }
      if (event.attributes && Object.keys(event.attributes).length > 0) {
        formatted.attributes = event.attributes
      }
      return formatted
    })

    // Store serialized events as a meta tag for native export
    // The native side will deserialize and handle appropriately
    this._spanContext.setTag('_dd.span_events', JSON.stringify(events))
  }
}

// Make NativeDatadogSpan instanceof DatadogSpan work
// This is important for compatibility with existing code that checks span types
Object.setPrototypeOf(NativeDatadogSpan.prototype, DatadogSpan.prototype)

module.exports = NativeDatadogSpan
