'use strict'

// TODO (new internal tracer): use DC events for lifecycle metrics and test them
const { performance } = require('perf_hooks')
const now = performance.now.bind(performance)
const util = require('util')
const { channel } = require('dc-polyfill')
const id = require('../id')
const tagger = require('../tagger')
const runtimeMetrics = require('../runtime_metrics')
const log = require('../log')
const { storage } = require('../../../datadog-core')
const { resolveServiceSource } = require('../service-naming/source-resolver')
const telemetryMetrics = require('../telemetry/metrics')
const { MANUAL_DROP, MANUAL_KEEP, SAMPLING_PRIORITY } = require('../../../../ext/tags')
const { DD_MAJOR } = require('../../../../version')
const { getDatadogContext } = require('./context-registry')
const eventWriter = require('./event-writer')
const { isSpanFinished } = require('./span-lifecycle')
const SpanContext = require('./span_context')
const { setSpanStore } = require('./span-store')

const dateNow = Date.now

const tracerMetrics = telemetryMetrics.manager.namespace('tracers')

const unfinishedRegistry = createRegistry('unfinished')
const finishedRegistry = createRegistry('finished')

let OTEL_ENABLED = false
const ALLOWED = new Set(['string', 'number', 'boolean'])

const integrationCounters = {
  spans_created: {},
  spans_finished: {},
}

const startCh = channel('dd-trace:span:start')
const finishCh = channel('dd-trace:span:finish')
const tagsUpdateCh = channel('dd-trace:span:tags:update')

// Module-scope so we don't allocate a fresh recursive closure on every
// `addLink` / `addEvent`.
/**
 * @param {Record<string, string> | undefined} out Accumulator, created lazily
 * on the first surviving entry so an all-dropped set stays `undefined`.
 * @param {string} key
 * @param {unknown} value
 * @returns {Record<string, string> | undefined}
 */
function addArrayOrScalarAttribute (out, key, value) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      out = addArrayOrScalarAttribute(out, `${key}.${i}`, value[i])
    }
    return out
  }
  if (ALLOWED.has(typeof value)) {
    out ??= {}
    out[key] = typeof value === 'string' ? value : String(value)
    return out
  }
  log.warn('Dropping span link attribute. It is not of an allowed type')
  return out
}

function getIntegrationCounter (event, integration) {
  const counters = integrationCounters[event]

  if (integration in counters) {
    return counters[integration]
  }

  const counter = tracerMetrics.count(event, [
    `integration_name:${integration.toLowerCase()}`,
    `otel_enabled:${OTEL_ENABLED}`,
  ])

  integrationCounters[event][integration] = counter

  return counter
}

class DatadogSpan {
  #parentTracer

  constructor (tracer, processor, prioritySampler, fields, debug) {
    OTEL_ENABLED = tracer._config.DD_TRACE_OTEL_ENABLED

    const operationName = fields.operationName
    const parent = fields.parent || null
    const hostname = fields.hostname
    const integrationName = fields.integrationName || 'opentracing'

    this.#parentTracer = tracer
    const spanContext = this._createContext(parent, fields)
    const startTime = fields.startTime || getTime(spanContext)
    const links = fields.links?.map(link => ({
      context: getDatadogContext(link.context) ?? link.context,
      attributes: this._sanitizeAttributes(link.attributes),
    })) ?? []

    eventWriter.startSpan(this, {
      context: spanContext,
      processor,
      prioritySampler,
      debug,
      operationName,
      integrationName,
      startTime,
      links,
      hostname,
      parentContext: parent,
    })
    setSpanStore(this, storage('legacy').getHandle())
    if (fields.tags) eventWriter.setTags(this, fields.tags)

    getIntegrationCounter('spans_created', integrationName).inc()

    if (this.#parentTracer._config.DD_TRACE_EXPERIMENTAL_SPAN_COUNTS && finishedRegistry) {
      runtimeMetrics.increment('runtime.node.spans.unfinished')
      runtimeMetrics.increment('runtime.node.spans.unfinished.by.name', `span_name:${operationName}`)

      runtimeMetrics.increment('runtime.node.spans.open') // unfinished for real
      runtimeMetrics.increment('runtime.node.spans.open.by.name', `span_name:${operationName}`)

      unfinishedRegistry.register(this, operationName, this)
    }

    if (tracer._config.DD_TRACE_SPAN_LEAK_DEBUG > 0) {
      require('../spanleak').addSpan(this)
    }

    if (startCh.hasSubscribers) {
      startCh.publish({ span: this, fields })
    }
  }

  [util.inspect.custom] () {
    return {
      ...this,
      parentTracer: `[${this.#parentTracer.constructor.name}]`,
      _prioritySampler: `[${this._prioritySampler.constructor.name}]`,
      _processor: `[${this._processor.constructor.name}]`,
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
      resource,
    })

    return `Span${json}`
  }

  /**
   * @returns {import('./span_context')}
   */
  context () {
    return this._spanContext
  }

  tracer () {
    return this.#parentTracer
  }

  setOperationName (name) {
    eventWriter.setOperationName(this, name)
    return this
  }

  /**
   * Set the integration that owns this span.
   *
   * @param {string} name
   * @returns {DatadogSpan}
   */
  setIntegrationName (name) {
    eventWriter.setIntegrationName(this, name)
    return this
  }

  /**
   * Enable or disable recording for this span's trace.
   *
   * @param {boolean} enabled
   * @returns {DatadogSpan}
   */
  setRecording (enabled) {
    eventWriter.setRecording(this, enabled)
    return this
  }

  setBaggageItem (key, value) {
    eventWriter.setBaggageItem(this, key, value)
    return this
  }

  getBaggageItem (key) {
    return this._spanContext._baggageItems[key]
  }

  getAllBaggageItems () {
    return JSON.stringify(this._spanContext._baggageItems)
  }

  removeBaggageItem (key) {
    eventWriter.removeBaggageItem(this, key)
  }

  removeAllBaggageItems () {
    eventWriter.removeAllBaggageItems(this)
  }

  setTag (key, value) {
    this._spanContext.setTag(key, value)

    if (isSamplingPriorityTag(key)) {
      this._prioritySampler.sample(this, false)
    }

    if (tagsUpdateCh.hasSubscribers) {
      tagsUpdateCh.publish(this)
    }

    return this
  }

  /**
   * Set a tag only when it is absent, without exposing the current tag value.
   *
   * @param {string} key
   * @param {unknown} value
   * @returns {boolean}
   */
  setTagIfAbsent (key, value) {
    const written = eventWriter.setTagIfAbsent(this, key, value)
    if (written && tagsUpdateCh.hasSubscribers) tagsUpdateCh.publish(this)
    return written
  }

  addTags (keyValueMap) {
    // v6 hot path: `Object.assign` straight onto the live tag map. The
    // string and array shapes never appeared in the public TypeScript
    // surface, and no internal v6 caller passes one (see MIGRATING.md).
    // v5 still accepts both via `tagger.add` for `config.tags` /
    // `options.tags` callers that pass `'key:val,key:val'` strings.
    let mayChangeSamplingPriority

    if (keyValueMap !== null && typeof keyValueMap === 'object' && !Array.isArray(keyValueMap)) {
      eventWriter.setTags(this, keyValueMap)
      mayChangeSamplingPriority =
        MANUAL_KEEP in keyValueMap ||
        MANUAL_DROP in keyValueMap ||
        SAMPLING_PRIORITY in keyValueMap
    } else {
      /* istanbul ignore if: v5 fallback, master ships 6.0.0-pre */
      if (DD_MAJOR < 6 && (typeof keyValueMap === 'string' || Array.isArray(keyValueMap))) {
        const tags = {}
        tagger.add(tags, keyValueMap)
        eventWriter.setTags(this, tags)
        mayChangeSamplingPriority = true
      } else {
        return this
      }
    }

    if (mayChangeSamplingPriority) {
      this._prioritySampler.sample(this, false)
    }

    if (tagsUpdateCh.hasSubscribers) {
      tagsUpdateCh.publish(this)
    }

    return this
  }

  /**
   * Set tags only while a caller-owned tag value still matches the span.
   *
   * @param {string} expectedKey
   * @param {unknown} expectedValue
   * @param {Record<string, unknown>} tags
   * @returns {boolean}
   */
  setTagsIfTagMatches (expectedKey, expectedValue, tags) {
    const written = eventWriter.setTagsIfTagMatches(this, expectedKey, expectedValue, tags)
    if (written && tagsUpdateCh.hasSubscribers) tagsUpdateCh.publish(this)
    return written
  }

  log () {
    return this
  }

  logEvent () {}

  addLink (link, attrs) {
    // v5 still accepts the legacy `addLink(spanContext, attrs)` shape; v6 only takes
    // `addLink({ context, attributes })`.
    if (DD_MAJOR < 6 && link instanceof SpanContext) {
      link = { context: link, attributes: attrs ?? {} }
    }

    const { context, attributes } = link

    eventWriter.addLink(this, {
      context: getDatadogContext(context) ?? context,
      attributes: this._sanitizeAttributes(attributes),
    })
  }

  addLinks (links) {
    for (const link of links) {
      this.addLink(link)
    }
    return this
  }

  addSpanPointer (ptrKind, ptrDir, ptrHash) {
    const zeroContext = new SpanContext({
      traceId: id('0'),
      spanId: id('0'),
    })
    const attributes = {
      'ptr.kind': ptrKind,
      'ptr.dir': ptrDir,
      'ptr.hash': ptrHash,
      'link.kind': 'span-pointer',
    }
    this.addLink({ context: zeroContext, attributes })
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
    eventWriter.addEvent(this, event)
  }

  /**
   * Set structured span metadata.
   *
   * @param {string} key
   * @param {unknown} value
   * @returns {DatadogSpan}
   */
  setStructuredTag (key, value) {
    eventWriter.setStructuredTag(this, key, value)
    return this
  }

  /**
   * Set structured span metadata only when the key is absent.
   *
   * @param {string} key
   * @param {unknown} value
   * @returns {boolean}
   */
  setStructuredTagIfAbsent (key, value) {
    return eventWriter.setStructuredTagIfAbsent(this, key, value)
  }

  /**
   * Append a stack trace while atomically enforcing its configured cap.
   *
   * @param {string} namespace
   * @param {object} value
   * @param {number} maxItems
   * @returns {boolean}
   */
  appendStackTrace (namespace, value, maxItems) {
    return eventWriter.appendStackTrace(this, namespace, value, maxItems)
  }

  /**
   * Finish all open child spans, optionally restricted to an integration.
   *
   * @param {string} [integrationName]
   * @returns {DatadogSpan}
   */
  finishOpenChildren (integrationName) {
    eventWriter.finishOpenChildren(this, integrationName)
    return this
  }

  finish (finishTime) {
    if (isSpanFinished(this)) return

    if (this.#parentTracer._config.DD_TRACE_EXPERIMENTAL_STATE_TRACKING && !this._spanContext.getTag('service.name')) {
      log.error('Finishing invalid span: %s', this)
    }

    getIntegrationCounter('spans_finished', this._integrationName).inc()
    this._spanContext.setTag('_dd.integration', this._integrationName)

    resolveServiceSource(this, this.#parentTracer._service)

    if (this.#parentTracer._config.DD_TRACE_EXPERIMENTAL_SPAN_COUNTS && finishedRegistry) {
      runtimeMetrics.decrement('runtime.node.spans.unfinished')
      runtimeMetrics.decrement('runtime.node.spans.unfinished.by.name', `span_name:${this._name}`)
      runtimeMetrics.increment('runtime.node.spans.finished')
      runtimeMetrics.increment('runtime.node.spans.finished.by.name', `span_name:${this._name}`)

      runtimeMetrics.decrement('runtime.node.spans.open') // unfinished for real
      runtimeMetrics.decrement('runtime.node.spans.open.by.name', `span_name:${this._name}`)

      unfinishedRegistry.unregister(this)
      finishedRegistry.register(this, this._name)
    }

    // Dominant call site is `span.finish()` with no argument; skip the
    // `Number.parseFloat` round-trip for the undefined case.
    finishTime = finishTime === undefined
      ? this._getTime()
      : (Number.parseFloat(finishTime) || this._getTime())

    if (!eventWriter.finishSpan(this, finishTime)) return
    finishCh.publish(this)
    this._processor.process(this)
  }

  /**
   * @param {Record<string, unknown>} [attributes]
   * @returns {Record<string, string> | undefined} `undefined` when nothing
   * survives, so `extractSpanLinks` omits the slot without an emptiness probe.
   */
  _sanitizeAttributes (attributes = {}) {
    let out
    for (const key of Object.keys(attributes)) {
      out = addArrayOrScalarAttribute(out, key, attributes[key])
    }
    return out
  }

  /**
   * @param {Record<string, unknown>} [attributes]
   * @returns {Record<string, unknown> | undefined} `undefined` when nothing
   * survives, so the encoders skip the slot without an emptiness probe.
   */
  _sanitizeEventAttributes (attributes = {}) {
    let sanitizedAttributes

    for (const key of Object.keys(attributes)) {
      const value = attributes[key]
      if (Array.isArray(value)) {
        const newArray = []
        for (const subvalue of value) {
          if (ALLOWED.has(typeof subvalue)) {
            newArray.push(subvalue)
          } else {
            log.warn('Dropping span event attribute. It is not of an allowed type')
          }
        }
        sanitizedAttributes ??= {}
        sanitizedAttributes[key] = newArray
      } else if (ALLOWED.has(typeof value)) {
        sanitizedAttributes ??= {}
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

    let baggage
    const propagationBehavior = this.#parentTracer._config.DD_TRACE_PROPAGATION_BEHAVIOR_EXTRACT
    if (parent && parent._isRemote && propagationBehavior !== 'continue') {
      baggage = parent._baggageItems
      parent = null
    }

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
        baggageItems: { ...parent._baggageItems },
        trace: parent._trace,
        tracestate: parent._tracestate,
      })

      if (!spanContext._trace.startTime) {
        startTime = dateNow()
      }
    } else {
      const spanId = id()
      startTime = dateNow()
      spanContext = new SpanContext({
        traceId: spanId,
        spanId,
      })
      eventWriter.setTraceStartTime(spanContext, startTime)

      if (fields.traceId128BitGenerationEnabled) {
        eventWriter.setTraceTag(spanContext, '_dd.p.tid', Math.floor(startTime / 1000).toString(16)
          .padStart(8, '0')
          .padEnd(16, '0'))
      }

      if (propagationBehavior === 'restart') {
        eventWriter.replaceBaggageItems(spanContext, baggage ?? {})
      }
    }

    eventWriter.setTraceTicksIfAbsent(spanContext, now)
    if (startTime) {
      eventWriter.setTraceStartTime(spanContext, startTime)
    }
    // SpanContext was NOT propagated from a remote parent
    eventWriter.setRemote(spanContext, false)

    return spanContext
  }

  _getTime () {
    return getTime(this._spanContext)
  }
}

/**
 * @param {import('./span_context')} context
 * @returns {number}
 */
function getTime (context) {
  const { startTime, ticks } = context._trace
  return startTime + now() - ticks
}

function createRegistry (type) {
  return new global.FinalizationRegistry(name => {
    runtimeMetrics.decrement(`runtime.node.spans.${type}`)
    runtimeMetrics.decrement(`runtime.node.spans.${type}.by.name`, [`span_name:${name}`])
  })
}

function isSamplingPriorityTag (key) {
  return key === MANUAL_KEEP || key === MANUAL_DROP || key === SAMPLING_PRIORITY
}

module.exports = DatadogSpan
