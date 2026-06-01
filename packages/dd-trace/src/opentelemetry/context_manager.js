'use strict'

const { trace, ROOT_CONTEXT, propagation } = require('@opentelemetry/api')
const { storage } = require('../../../datadog-core')
const { getAllBaggageItems, setAllBaggageItems, removeAllBaggageItems } = require('../baggage')

const ActiveSpanProxy = require('./active-span-proxy')
const SpanContext = require('./span_context')

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
    const baggages = getAllBaggageItems()
    const hasBaggage = Object.keys(baggages).length > 0
    let otelBaggages
    if (hasBaggage) {
      const entries = {}
      for (const [key, value] of Object.entries(baggages)) {
        entries[key] = { value }
      }
      otelBaggages = propagation.createBaggage(entries)
    }

    // If stored span wraps the active DD span, prefer the stored context
    if (storedSpan && storedSpan._ddSpan === activeSpan) {
      if (otelBaggages) return propagation.setBaggage(store, otelBaggages)
      return store
    }

    if (!activeSpan) {
      if (otelBaggages) return propagation.setBaggage(baseContext, otelBaggages)
      return baseContext
    }

    const ddContext = activeSpan.context()

    if (!ddContext._otelSpanContext) {
      ddContext._otelSpanContext = new SpanContext(ddContext)
    }

    // Cache the active-span proxy next to the bridge span context. This lets
    // `trace.getActiveSpan()` forward attribute/status/link/exception writes
    // onto the active Datadog span rather than returning a NonRecordingSpan
    // whose mutation methods are silent no-ops.
    if (!ddContext._otelActiveSpan) {
      ddContext._otelActiveSpan = new ActiveSpanProxy(activeSpan, ddContext._otelSpanContext)
    }

    if (store && trace.getSpan(store) === ddContext._otelActiveSpan) {
      return otelBaggages ? propagation.setBaggage(store, otelBaggages) : store
    }

    const wrappedContext = trace.setSpan(baseContext, ddContext._otelActiveSpan)
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
    if (span && span._ddSpan) {
      const ddSpan = span._ddSpan
      const parentStore = storage('legacy').getStore(ddSpan._store) ?? storage('legacy').getStore()
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
