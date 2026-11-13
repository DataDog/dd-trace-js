'use strict'

const { storage } = require('../../../datadog-core')
const { getAllBaggageItems, setAllBaggageItems, removeAllBaggageItems } = require('../baggage')
const api = require('./api')

const ActiveSpanProxy = require('./active-span-proxy')
const SpanContext = require('./span_context')

class ContextManager {
  constructor () {
    this._store = storage('opentelemetry')
  }

  // converts dd to otel
  active () {
    const store = this._store.getStore()
    const baseContext = store || api.ROOT_CONTEXT
    const activeSpan = storage('legacy').getStore()?.span

    const storedSpan = store ? api.trace.getSpan(store) : null

    // Convert DD baggage to OTel format
    let entries
    for (const [key, value] of Object.entries(getAllBaggageItems())) {
      entries ??= {}
      entries[key] = { value }
    }

    let otelBaggages
    if (entries !== undefined) {
      otelBaggages = api.propagation.createBaggage(entries)
    }

    // If stored span wraps the active DD span, prefer the stored context
    if (storedSpan && storedSpan._ddSpan === activeSpan) {
      if (otelBaggages) return api.propagation.setBaggage(store, otelBaggages)
      return store
    }

    if (!activeSpan) {
      if (otelBaggages) return api.propagation.setBaggage(baseContext, otelBaggages)
      return baseContext
    }

    const ddContext = activeSpan.context()

    if (!ddContext._otelSpanContext) {
      ddContext._otelSpanContext = new SpanContext(ddContext)
    }

    // Cache the active-span proxy next to the bridge span context. This lets
    // `api.trace.getActiveSpan()` forward attribute/status/link/exception writes
    // onto the active Datadog span rather than returning a NonRecordingSpan
    // whose mutation methods are silent no-ops.
    if (!ddContext._otelActiveSpan) {
      ddContext._otelActiveSpan = new ActiveSpanProxy(activeSpan, ddContext._otelSpanContext)
    }

    const wrappedContext = api.trace.setSpan(baseContext, ddContext._otelActiveSpan)
    return otelBaggages ? api.propagation.setBaggage(wrappedContext, otelBaggages) : wrappedContext
  }

  // converts otel to dd
  with (context, fn, thisArg, ...args) {
    const span = api.trace.getSpan(context)
    const run = () => {
      const cb = thisArg == null ? fn : fn.bind(thisArg)
      return this._store.run(context, cb, ...args)
    }
    const baggages = api.propagation.getBaggage(context)
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
    if (span && span._ddSpan) {
      const ddSpan = span._ddSpan
      const parentStore = storage('legacy').getStore(ddSpan._store) ?? storage('legacy').getStore()
      return storage('legacy').run({ ...parentStore, span: ddSpan }, run)
    }
    return run()
  }

  bind (context, target) {
    // Per the OTel contract, only functions are wrapped; other targets are returned as-is.
    if (typeof target !== 'function') return target

    const self = this
    return function (...args) {
      return self.with(context, target, this, ...args)
    }
  }

  enable () {}
  disable () {}
}
module.exports = ContextManager
