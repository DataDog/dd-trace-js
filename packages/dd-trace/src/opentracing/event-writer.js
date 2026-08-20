'use strict'

/* eslint-disable eslint-rules/eslint-no-private-tags-access */

const { channel } = require('dc-polyfill')
const { AUTO_REJECT, USER_KEEP, USER_REJECT } = require('../../../../ext/priority')
const { isSpanFinished, markSpanFinished, markSpanStarted } = require('./span-lifecycle')

const contextInitializedCh = channel('dd-trace:span:event-writer:context-initialized')
const spanStartedCh = channel('dd-trace:span:event-writer:span-started')
const tagsClearedCh = channel('dd-trace:span:event-writer:tags-cleared')
const tagDeletedCh = channel('dd-trace:span:event-writer:tag-deleted')
const tagSetCh = channel('dd-trace:span:event-writer:tag-set')
const tagsSetCh = channel('dd-trace:span:event-writer:tags-set')
const traceTagSetCh = channel('dd-trace:span:event-writer:trace-tag-set')
const traceTagsSetCh = channel('dd-trace:span:event-writer:trace-tags-set')

/**
 * Compatibility EventWriter backed by the current JavaScript span objects.
 *
 * The public methods are the write boundary that a native implementation will
 * replace. Production callers must not mutate the backing fields directly.
 */
class EventWriter {
  /**
   * @param {import('./span_context')} context
   * @param {object} [props]
   */
  initializeContext (context, props = {}) {
    context._traceId = props.traceId
    context._spanId = props.spanId
    context._isRemote = props.isRemote ?? true
    context._parentId = props.parentId || null
    context._name = props.name
    context._isFinished = props.isFinished || false
    context._tags = props.tags || {}
    context._sampling = props.sampling || {}
    context._spanSampling = undefined
    context._links = props.links || []
    context._baggageItems = props.baggageItems || {}
    context._traceparent = props.traceparent
    context._tracestate = props.tracestate
    context._noop = props.noop || null
    context._trace = props.trace || {
      started: [],
      finished: [],
      tags: {},
    }
    if (contextInitializedCh.hasSubscribers) {
      contextInitializedCh.publish({ context, traceIdentity: context._trace })
    }
    if (props.trace?.tags && traceTagsSetCh.hasSubscribers) {
      traceTagsSetCh.publish({ context, tags: props.trace.tags })
    }
  }

  /**
   * @param {import('./span')} span
   * @param {object} fields
   * @param {import('./span_context')} fields.context
   * @param {object} fields.processor
   * @param {object} fields.prioritySampler
   * @param {unknown} fields.debug
   * @param {string} fields.operationName
   * @param {string} fields.integrationName
   * @param {number} fields.startTime
   * @param {Array<object>} fields.links
   * @param {string} [fields.hostname]
   * @param {import('./span_context')} [fields.parentContext]
   */
  startSpan (span, fields) {
    const {
      context,
      processor,
      prioritySampler,
      debug,
      operationName,
      integrationName,
      startTime,
      links,
      hostname,
    } = fields

    span._debug = debug
    span._processor = processor
    span._prioritySampler = prioritySampler
    span._duration = undefined
    span._events = []
    span._name = operationName
    span._integrationName = integrationName
    span._spanContext = context
    span._startTime = startTime
    span._links = links

    context._name = operationName
    context._hostname = hostname
    context._trace.started.push(span)
    markSpanStarted(span)
    if (spanStartedCh.hasSubscribers) {
      spanStartedCh.publish({
        span,
        context,
        parentContext: fields.parentContext,
        traceIdentity: context._trace,
        spanId: context._spanId,
        parentId: context._parentId,
        operationName,
        startTime,
      })
    }
  }

  /**
   * @param {import('./span')} span
   * @param {string} name
   */
  setOperationName (span, name) {
    span._spanContext._name = name
  }

  /**
   * @param {import('./span')} span
   * @param {string} name
   */
  setIntegrationName (span, name) {
    span._integrationName = name
  }

  /**
   * @param {import('./span')} span
   * @param {boolean} enabled
   */
  setRecording (span, enabled) {
    span._spanContext._trace.record = enabled
    span._spanContext._trace.isRecording = enabled
  }

  /**
   * @param {import('./span')|import('./span_context')} target
   * @param {string} key
   * @param {unknown} value
   */
  setTag (target, key, value) {
    const context = getContext(target)
    context._tags[key] = value
    if (tagSetCh.hasSubscribers) tagSetCh.publish({ context, key, value })
  }

  /**
   * @param {import('./span')|import('./span_context')} target
   * @param {Record<string, unknown>} tags
   */
  setTags (target, tags) {
    const context = getContext(target)
    Object.assign(context._tags, tags)
    if (tagsSetCh.hasSubscribers) tagsSetCh.publish({ context, tags })
  }

  /**
   * Set multiple tags when an ownership tag is absent or still has the expected value.
   *
   * @param {import('./span')|import('./span_context')} target
   * @param {string} expectedKey
   * @param {unknown} expectedValue
   * @param {Record<string, unknown>} tags
   * @returns {boolean}
   */
  setTagsIfTagMatches (target, expectedKey, expectedValue, tags) {
    const context = getContext(target)
    const currentValue = context._tags[expectedKey]
    if (currentValue !== undefined && currentValue !== expectedValue) return false
    Object.assign(context._tags, tags)
    if (tagsSetCh.hasSubscribers) tagsSetCh.publish({ context, tags })
    return true
  }

  /**
   * Copy selected tags without exposing the source span's tag state.
   *
   * @param {import('./span')} source
   * @param {import('./span')} destination
   * @param {Array<[string, string]>} mappings
   */
  copyTags (source, destination, mappings) {
    const tags = source._spanContext._tags
    for (const [sourceTag, destinationTag] of mappings) {
      const value = tags[sourceTag]
      if (value !== undefined && value !== null) {
        this.setTag(destination, destinationTag, value)
      }
    }
  }

  /**
   * Atomically write automatic login tags without replacing SDK-owned values.
   *
   * @param {import('./span')} span
   * @param {string} sdkTag
   * @param {Record<string, unknown>} tags
   * @param {Set<string>} sdkOwnedTags
   * @param {string} trackedTag
   * @returns {boolean}
   */
  setAppSecAutoLoginTags (span, sdkTag, tags, sdkOwnedTags, trackedTag) {
    const context = span._spanContext
    const sdkCalled = context._tags[sdkTag] === 'true'
    let trackedTagWritten = false

    for (const key of Object.keys(tags)) {
      if (sdkCalled && sdkOwnedTags.has(key) && context._tags[key]) continue
      this.setTag(span, key, tags[key])
      if (key === trackedTag) trackedTagWritten = true
    }

    return trackedTagWritten
  }

  /**
   * Atomically write automatic user tags unless the SDK owns user collection.
   * The internal AppSec user identifier is recorded in either case.
   *
   * @param {import('./span')} span
   * @param {string} userId
   * @param {string} collectionMode
   * @returns {boolean}
   */
  setAppSecAutoUser (span, userId, collectionMode) {
    this.setTag(span, '_dd.appsec.usr.id', userId)

    if (span._spanContext._tags['_dd.appsec.user.collection_mode'] === 'sdk') return false

    this.setTags(span, {
      'usr.id': userId,
      '_dd.appsec.user.collection_mode': collectionMode,
    })
    return true
  }

  /**
   * Atomically merge an AppSec attack into the span's event tags.
   *
   * @param {import('./span')} span
   * @param {Array<unknown>} attackData
   * @param {string|undefined} remoteAddress
   * @returns {string}
   */
  addAppSecEvent (span, attackData, remoteAddress) {
    const tags = span._spanContext._tags
    const currentJson = tags['_dd.appsec.json']
    const attackDataString = JSON.stringify(attackData)
    const appSecJson = currentJson
      ? currentJson.slice(0, -2) + ',' + attackDataString.slice(1) + '}'
      : '{"triggers":' + attackDataString + '}'

    this.setTag(span, 'appsec.event', 'true')
    this.setTagIfAbsent(span, '_dd.origin', 'appsec')
    this.setTag(span, '_dd.appsec.json', appSecJson)
    if (remoteAddress !== undefined) this.setTag(span, 'network.client.ip', remoteAddress)
    return appSecJson
  }

  /**
   * @param {import('./span')|import('./span_context')} target
   * @param {string} key
   * @param {unknown} value
   * @returns {boolean}
   */
  setTagIfAbsent (target, key, value) {
    const context = getContext(target)
    const tags = context._tags
    if (Object.hasOwn(tags, key)) return false
    tags[key] = value
    if (tagSetCh.hasSubscribers) tagSetCh.publish({ context, key, value })
    return true
  }

  /**
   * Atomically add the initial web request tags once, using `http.url` as the
   * ownership marker.
   *
   * @param {import('./span')} span
   * @param {Record<string, unknown>} tags
   * @returns {boolean}
   */
  setWebRequestTagsIfAbsent (span, tags) {
    const context = getContext(span)
    if (Object.hasOwn(context._tags, 'http.url')) return false
    this.setTags(context, tags)
    return true
  }

  /**
   * Set the web error tag unless an error or error message already owns the
   * span's error state.
   *
   * @param {import('./span')} span
   * @param {unknown} value
   * @returns {boolean}
   */
  setWebErrorIfAbsent (span, value) {
    const tags = getContext(span)._tags
    if (tags.error || tags['error.message']) return false
    this.setTag(span, 'error', value)
    return true
  }

  /**
   * Derive the endpoint from the stored request URL without exposing that URL
   * to the caller.
   *
   * @param {import('./span')} span
   * @param {(url: string) => string} calculateEndpoint
   * @returns {boolean}
   */
  setHttpEndpointIfAbsent (span, calculateEndpoint) {
    const tags = getContext(span)._tags
    if (Object.hasOwn(tags, 'http.route') || Object.hasOwn(tags, 'http.endpoint')) return false
    const url = tags['http.url']
    this.setTag(span, 'http.endpoint', url ? calculateEndpoint(String(url)) : '/')
    return true
  }

  /**
   * Derive the web resource from the request method and stored route without
   * returning either tag to the caller.
   *
   * @param {import('./span')} span
   * @param {string|undefined} method
   * @returns {boolean}
   */
  setWebResourceNameIfAbsent (span, method) {
    const tags = getContext(span)._tags
    if (tags['resource.name']) return false
    const route = tags['http.route']
    const resource = method && route ? `${method} ${route}` : method || route || ''
    this.setTag(span, 'resource.name', resource)
    return true
  }

  /**
   * Resolve the final service-source tag atomically at span finish.
   *
   * @param {import('./span')} span
   * @param {string|undefined} tracerService
   * @param {string|undefined} integrationService
   * @param {string} sourceKey
   * @param {string} manualSource
   */
  resolveServiceSource (span, tracerService, integrationService, sourceKey, manualSource) {
    const tags = getContext(span)._tags
    const currentService = tags['service.name']
    const existingSource = tags[sourceKey]

    if (currentService === tracerService) {
      if (existingSource !== undefined) this.setTag(span, sourceKey, undefined)
      return
    }

    if (integrationService !== currentService) this.setTag(span, sourceKey, manualSource)
  }

  /**
   * @param {import('./span')|import('./span_context')} target
   * @param {string} key
   */
  deleteTag (target, key) {
    const context = getContext(target)
    delete context._tags[key]
    if (tagDeletedCh.hasSubscribers) tagDeletedCh.publish({ context, key })
  }

  /**
   * @param {import('./span')|import('./span_context')} target
   */
  clearTags (target) {
    const context = getContext(target)
    context._tags = Object.create(null)
    if (tagsClearedCh.hasSubscribers) tagsClearedCh.publish({ context })
  }

  /**
   * Ensure priority sampling has run and atomically decide whether API Security
   * may retain the request.
   *
   * @param {import('./span')} span
   * @returns {boolean}
   */
  sampleForApiSecurity (span) {
    const context = span._spanContext
    if (context._sampling.priority === undefined) {
      span._prioritySampler?.sample(span)
    }
    const priority = context._sampling.priority
    return priority !== AUTO_REJECT && priority !== USER_REJECT
  }

  /**
   * @param {import('./span')|import('./span_context')} target
   * @param {string} key
   * @param {unknown} value
   */
  setTraceTag (target, key, value) {
    const context = getContext(target)
    context._trace.tags[key] = value
    if (traceTagSetCh.hasSubscribers) traceTagSetCh.publish({ context, key, value })
  }

  /**
   * Set a trace-level propagation tag only when it has no defined value.
   *
   * @param {import('./span')|import('./span_context')} target
   * @param {string} key
   * @param {unknown} value
   * @returns {boolean}
   */
  setTraceTagIfAbsent (target, key, value) {
    const context = getContext(target)
    const tags = context._trace.tags
    if (tags[key] !== undefined) return false
    tags[key] = value
    if (traceTagSetCh.hasSubscribers) traceTagSetCh.publish({ context, key, value })
    return true
  }

  /**
   * Set multiple trace-level propagation tags.
   *
   * @param {import('./span')|import('./span_context')} target
   * @param {Record<string, unknown>} tags
   */
  setTraceTags (target, tags) {
    const context = getContext(target)
    Object.assign(context._trace.tags, tags)
    if (traceTagsSetCh.hasSubscribers) traceTagsSetCh.publish({ context, tags })
  }

  /**
   * @param {import('./span')|import('./span_context')} target
   * @param {string|undefined} origin
   */
  setOrigin (target, origin) {
    getContext(target)._trace.origin = origin
  }

  /**
   * @param {import('./span_context')} context
   * @param {number|undefined} priority
   * @param {number} [mechanism]
   */
  setSamplingPriority (context, priority, mechanism) {
    context._sampling.priority = priority
    if (mechanism !== undefined) context._sampling.mechanism = mechanism
  }

  /**
   * @param {import('./span_context')} context
   * @param {number} mechanism
   */
  setSamplingMechanism (context, mechanism) {
    context._sampling.mechanism = mechanism
  }

  /**
   * @param {import('./span_context')} context
   * @param {{ sampleRate: number, maxPerSecond: number }} decision
   */
  setSpanSamplingDecision (context, decision) {
    context._spanSampling = decision
  }

  /**
   * Keep a trace using the span's configured priority sampler.
   *
   * @param {import('./span')} span
   * @param {{ id: number, mechanism?: number }} [product]
   */
  keepTrace (span, product) {
    span._prioritySampler?.setPriority(span, USER_KEEP, product)
  }

  /**
   * Record an internal trace-level sampling decision input.
   *
   * @param {import('./span')|import('./span_context')} target
   * @param {string|symbol} key
   * @param {unknown} value
   */
  setTraceDecision (target, key, value) {
    getContext(target)._trace[key] = value
  }

  /**
   * Replace the span identifier in a propagation context.
   *
   * @param {import('./span_context')} context
   * @param {object} spanId
   */
  setSpanId (context, spanId) {
    context._spanId = spanId
  }

  /**
   * Update the W3C traceparent metadata associated with a context.
   *
   * @param {import('./span_context')} context
   * @param {object|undefined} traceparent
   */
  setTraceparent (context, traceparent) {
    context._traceparent = traceparent
  }

  /**
   * Update the W3C tracestate associated with a context.
   *
   * @param {import('./span_context')} context
   * @param {object|undefined} tracestate
   */
  setTracestate (context, tracestate) {
    context._tracestate = tracestate
  }

  /**
   * Append a pending propagation link to an extracted context.
   *
   * @param {import('./span_context')} context
   * @param {object} link
   */
  addContextLink (context, link) {
    context._links.push(link)
  }

  /**
   * Replace the pending propagation links on an extracted context.
   *
   * @param {import('./span_context')} context
   * @param {Array<object>} links
   */
  replaceContextLinks (context, links) {
    context._links = links
  }

  /**
   * @param {import('./span')} span
   * @param {string} key
   * @param {string} value
   */
  setBaggageItem (span, key, value) {
    getContext(span)._baggageItems[key] = value
  }

  /**
   * @param {import('./span')} span
   * @param {string} key
   */
  removeBaggageItem (span, key) {
    delete span._spanContext._baggageItems[key]
  }

  /**
   * @param {import('./span')} span
   */
  removeAllBaggageItems (span) {
    span._spanContext._baggageItems = {}
  }

  /**
   * @param {import('./span')} span
   * @param {object} link
   */
  addLink (span, link) {
    span._links.push(link)
  }

  /**
   * @param {import('./span')} span
   * @param {object} event
   */
  addEvent (span, event) {
    span._events.push(event)
  }

  /**
   * @param {import('./span')} span
   * @param {string} key
   * @param {unknown} value
   */
  setStructuredTag (span, key, value) {
    span.meta_struct ||= {}
    span.meta_struct[key] = value
  }

  /**
   * @param {import('./span')} span
   * @param {string} key
   * @param {unknown} value
   * @returns {boolean}
   */
  setStructuredTagIfAbsent (span, key, value) {
    span.meta_struct ||= {}
    if (Object.hasOwn(span.meta_struct, key)) return false
    span.meta_struct[key] = value
    return true
  }

  /**
   * @param {import('./span')} span
   * @param {string} namespace
   * @param {object} value
   * @param {number} maxItems
   * @returns {boolean}
   */
  appendStackTrace (span, namespace, value, maxItems) {
    span.meta_struct ||= {}
    const stacks = span.meta_struct['_dd.stack'] ||= {}
    const traces = stacks[namespace] ||= []
    if (maxItems >= 1 && traces.length >= maxItems) return false
    traces.push(value)
    return true
  }

  /**
   * @param {import('./span')} span
   * @param {number} finishTime
   * @returns {boolean} Whether the span transitioned to finished.
   */
  finishSpan (span, finishTime) {
    if (isSpanFinished(span)) return false
    const duration = finishTime - span._startTime
    span._duration = duration
    span._spanContext._trace.finished.push(span)
    span._spanContext._isFinished = true
    markSpanFinished(span, duration)
    return true
  }

  /**
   * Finish open spans in the same trace, optionally restricted to an integration.
   *
   * @param {import('./span')} span
   * @param {string} [integrationName]
   */
  finishOpenChildren (span, integrationName) {
    for (const child of span._spanContext._trace.started) {
      if (child === span || isSpanFinished(child)) continue
      if (integrationName !== undefined && child._integrationName !== integrationName) continue
      child.finish()
    }
  }

  /**
   * @param {import('./span_context')} context
   * @param {number} startTime
   */
  setTraceStartTime (context, startTime) {
    context._trace.startTime = startTime
  }

  /**
   * Copy the trace clock used to align manually constructed child contexts.
   *
   * @param {import('./span_context')} target
   * @param {import('./span_context')} source
   */
  copyTraceTiming (target, source) {
    target._trace.startTime = source._trace.startTime
    target._trace.ticks = source._trace.ticks
  }

  /**
   * @param {import('./span_context')} context
   * @param {() => number} getTicks
   */
  setTraceTicksIfAbsent (context, getTicks) {
    context._trace.ticks ||= getTicks()
  }

  /**
   * @param {import('./span_context')} context
   * @param {boolean} isRemote
   */
  setRemote (context, isRemote) {
    context._isRemote = isRemote
  }

  /**
   * @param {import('./span_context')} context
   * @param {Record<string, string>} baggageItems
   */
  replaceBaggageItems (context, baggageItems) {
    context._baggageItems = baggageItems
  }
}

/**
 * @param {import('./span')|import('./span_context')} target
 * @returns {import('./span_context')}
 */
function getContext (target) {
  return typeof target.context === 'function' ? target.context() : target
}

const eventWriter = new EventWriter()

module.exports = eventWriter
module.exports.EventWriter = EventWriter
