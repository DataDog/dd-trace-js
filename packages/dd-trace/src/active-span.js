'use strict'

const { kStoreRetirement, storage } = require('../../datadog-core/src/storage')
const SpanContext = require('./opentracing/span_context')

const legacyStorage = storage('legacy')
const kPendingStoreRetirements = Symbol('dd-trace.pending-store-retirements')
const pendingStoreSet = new WeakSet()
const retiredSpans = new WeakMap()

class RetiredSpan {
  #context
  #tracer

  /**
   * @param {import('./opentracing/span_context')} context
   * @param {import('./opentracing/tracer')} tracer
   */
  constructor (context, tracer) {
    this.#context = context
    this.#tracer = tracer
  }

  /**
   * @returns {import('./opentracing/span_context')}
   */
  context () {
    return this.#context
  }

  /**
   * @returns {import('./opentracing/tracer')}
   */
  tracer () {
    return this.#tracer
  }

  /**
   * @param {string} name
   * @returns {RetiredSpan}
   */
  setOperationName (name) {
    return this
  }

  /**
   * @param {string} key
   * @param {string} value
   * @returns {RetiredSpan}
   */
  setBaggageItem (key, value) {
    this.#context._baggageItems[key] = value
    return this
  }

  /**
   * @param {string} key
   * @returns {string | undefined}
   */
  getBaggageItem (key) {
    return this.#context._baggageItems[key]
  }

  /**
   * @returns {string}
   */
  getAllBaggageItems () {
    return JSON.stringify(this.#context._baggageItems)
  }

  /**
   * @param {string} key
   */
  removeBaggageItem (key) {
    delete this.#context._baggageItems[key]
  }

  removeAllBaggageItems () {
    this.#context._baggageItems = {}
  }

  /**
   * @param {string} key
   * @param {unknown} value
   * @returns {RetiredSpan}
   */
  setTag (key, value) {
    return this
  }

  /**
   * @param {Record<string, unknown>} keyValueMap
   * @returns {RetiredSpan}
   */
  addTags (keyValueMap) {
    return this
  }

  /**
   * @param {object} link
   * @param {object} [attributes]
   */
  addLink (link, attributes) {}

  /**
   * @param {object[]} links
   * @returns {RetiredSpan}
   */
  addLinks (links) {
    return this
  }

  /**
   * @param {string} pointerKind
   * @param {string} pointerDirection
   * @param {string} pointerHash
   */
  addSpanPointer (pointerKind, pointerDirection, pointerHash) {}

  /**
   * @param {string} name
   * @param {object | number} [attributesOrStartTime]
   * @param {number} [startTime]
   */
  addEvent (name, attributesOrStartTime, startTime) {}

  /**
   * @returns {RetiredSpan}
   */
  log () {
    return this
  }

  logEvent () {}

  /**
   * @param {number} [finishTime]
   */
  finish (finishTime) {}
}

class StoreRetirement {
  #context
  #retired = false
  #sourceContext
  #stores = []

  /**
   * @param {import('./opentracing/span_context')} [context]
   */
  constructor (context) {
    this.#sourceContext = context
  }

  /**
   * @param {object} store
   */
  add (store) {
    if (this.#retired) {
      retireStore(store)
    } else {
      this.#stores.push(store)
    }
  }

  /**
   * @param {import('./opentracing/span')} span
   * @returns {import('./opentracing/span_context')}
   */
  context (span) {
    if (!this.#context) {
      this.#context = this.#sourceContext
        ? createPropagationContext(this.#sourceContext)
        : span.context()
      this.#sourceContext = undefined
    }
    return this.#context
  }

  retire () {
    if (this.#retired) return

    this.#retired = true
    const stores = this.#stores
    this.#stores = []
    for (const store of stores) {
      retireStore(store)
    }
  }
}

/**
 * @param {import('./opentracing/span_context')} context
 * @returns {import('./opentracing/span_context')}
 */
function createPropagationContext (context) {
  const trace = context._trace
  return new SpanContext({
    traceId: context._traceId,
    spanId: context._spanId,
    parentId: context._parentId,
    isRemote: false,
    isFinished: true,
    name: context._name,
    sampling: context._sampling,
    baggageItems: context._baggageItems,
    traceparent: context._traceparent,
    tracestate: context._tracestate,
    trace: {
      started: [],
      finished: [],
      tags: trace.tags,
      ticks: trace.ticks,
      startTime: trace.startTime,
      origin: trace.origin,
      record: trace.record,
      isRecording: trace.isRecording,
    },
  })
}

/**
 * @param {import('./opentracing/span_context')} [context]
 * @returns {StoreRetirement}
 */
function createStoreRetirement (context) {
  return new StoreRetirement(context)
}

/**
 * @param {import('./opentracing/span')} span
 * @param {object | undefined} store
 * @param {StoreRetirement} retirement
 * @returns {object}
 */
function enterSpanForRetirement (span, store, retirement) {
  const activeStore = { ...store, span, [kStoreRetirement]: retirement }
  legacyStorage.enterWith(activeStore)
  return activeStore
}

/**
 * @param {object | undefined} store
 * @returns {import('./opentracing/span') | undefined}
 */
function getLiveSpan (store) {
  const span = store?.span
  return isRetiredSpan(span) ? undefined : span
}

/**
 * @param {object | undefined} store
 */
function retireStoreGroup (store) {
  store?.[kStoreRetirement]?.retire()
}

/**
 * @param {unknown} span
 * @returns {import('./opentracing/span_context') | undefined}
 */
function getRetiredSpanContext (span) {
  return span instanceof RetiredSpan ? span.context() : undefined
}

/**
 * @param {unknown} span
 * @returns {boolean}
 */
function isRetiredSpan (span) {
  return span instanceof RetiredSpan
}

/**
 * @param {object} store
 */
function retireStore (store) {
  const span = store.span
  if (!span || span._duration === undefined) return
  const trace = span.context()._trace
  if (!trace.started.includes(span)) {
    retireStoreNow(store, span)
  } else if (!pendingStoreSet.has(store)) {
    pendingStoreSet.add(store)
    const retirements = trace[kPendingStoreRetirements] ??= []
    retirements.push(store, span)
  }
}

/**
 * @param {object} trace
 * @param {object[]} retirements
 */
function retirePendingSpans (trace, retirements) {
  trace[kPendingStoreRetirements] = undefined
  for (let i = 0; i < retirements.length; i += 2) {
    retireStoreNow(retirements[i], retirements[i + 1])
  }
}

/**
 * @param {object} store
 * @param {import('./opentracing/span')} span
 */
function retireStoreNow (store, span) {
  if (store.span !== span) return

  const spanContext = span.context()
  const context = store[kStoreRetirement]?.context(span) ?? spanContext
  store.span = getRetiredSpan(context, span.tracer())
  store[kStoreRetirement] = undefined
  pendingStoreSet.delete(store)

  if (spanContext._otelActiveSpan?._ddSpan === span) {
    spanContext._otelActiveSpan._ddSpan = getRetiredSpan(spanContext, span.tracer())
  }
}

/**
 * @param {import('./opentracing/span_context')} context
 * @param {import('./opentracing/tracer')} tracer
 * @returns {RetiredSpan}
 */
function getRetiredSpan (context, tracer) {
  let span = retiredSpans.get(context)
  if (!span) {
    span = new RetiredSpan(context, tracer)
    retiredSpans.set(context, span)
  }
  return span
}

module.exports = {
  createStoreRetirement,
  enterSpanForRetirement,
  getLiveSpan,
  getRetiredSpanContext,
  isRetiredSpan,
  kPendingStoreRetirements,
  kStoreRetirement,
  retirePendingSpans,
  retireStoreGroup,
}
