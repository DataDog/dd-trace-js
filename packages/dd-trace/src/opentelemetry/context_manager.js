'use strict'

const { trace, ROOT_CONTEXT, propagation } = require('@opentelemetry/api')
const { storage } = require('../../../datadog-core')
const { getAllBaggageItems, setAllBaggageItems, removeAllBaggageItems } = require('../baggage')
const { getSpanStore } = require('../opentracing/span-store')

const ActiveSpanProxy = require('./active-span-proxy')
const SpanContext = require('./span_context')
const { getDatadogSpan } = require('./span-registry')

const activeSpans = new WeakMap()
const spanContexts = new WeakMap()

class ContextManager {
  constructor () {
    this._store = storage('opentelemetry')
  }

  // converts dd to otel
  active () {
    const store = this._store.getStore()
    const baseContext = store || ROOT_CONTEXT
    const activeSpan = storage('legacy').getStore()?.span

    const storedSpan = store ? trace.getSpan(store) : null

    // Convert DD baggage to OTel format
    let entries
    for (const [key, value] of Object.entries(getAllBaggageItems())) {
      entries ??= {}
      entries[key] = { value }
    }

    let otelBaggages
    if (entries !== undefined) {
      otelBaggages = propagation.createBaggage(entries)
    }

    // If stored span wraps the active DD span, prefer the stored context
    if (storedSpan && getDatadogSpan(storedSpan) === activeSpan) {
      if (otelBaggages) return propagation.setBaggage(store, otelBaggages)
      return store
    }

    if (!activeSpan) {
      if (otelBaggages) return propagation.setBaggage(baseContext, otelBaggages)
      return baseContext
    }

    const ddContext = activeSpan.context()
    let spanContext = spanContexts.get(ddContext)

    if (spanContext === undefined) {
      spanContext = new SpanContext(ddContext)
      spanContexts.set(ddContext, spanContext)
    }

    // Cache the active-span proxy next to the bridge span context. This lets
    // `trace.getActiveSpan()` forward attribute/status/link/exception writes
    // onto the active Datadog span rather than returning a NonRecordingSpan
    // whose mutation methods are silent no-ops.
    let otelActiveSpan = activeSpans.get(ddContext)
    if (otelActiveSpan === undefined) {
      otelActiveSpan = new ActiveSpanProxy(activeSpan, spanContext)
      activeSpans.set(ddContext, otelActiveSpan)
    }

    if (store && trace.getSpan(store) === otelActiveSpan) {
      return otelBaggages ? propagation.setBaggage(store, otelBaggages) : store
    }

    const wrappedContext = trace.setSpan(baseContext, otelActiveSpan)
    return otelBaggages ? propagation.setBaggage(wrappedContext, otelBaggages) : wrappedContext
  }

  // converts otel to dd
  with (context, fn, thisArg, ...args) {
    const span = trace.getSpan(context)
    const run = () => {
      const cb = thisArg == null ? fn : fn.bind(thisArg)
      return this._store.run(context, cb, ...args)
    }
    const baggages = propagation.getBaggage(context)
    const baggageItems = baggages ? baggages.getAllEntries() : []
    if (baggageItems.length > 0) {
      /** @type {Record<string, string>} */
      const items = {}
      for (const [key, entry] of baggageItems) {
        items[key] = entry.value
      }
      setAllBaggageItems(items)
    } else {
      removeAllBaggageItems()
    }
    const ddSpan = span && getDatadogSpan(span)
    if (ddSpan) {
      const parentStore = storage('legacy').getStore(getSpanStore(ddSpan)) ?? storage('legacy').getStore()
      return storage('legacy').run({ ...parentStore, span: ddSpan }, run)
    }
    return run()
  }

  bind (context, target) {
    const self = this
    return function (...args) {
      return self.with(context, target, this, ...args)
    }
  }

  enable () {}
  disable () {}
}
module.exports = ContextManager
