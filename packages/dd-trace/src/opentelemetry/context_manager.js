'use strict'

const { trace, ROOT_CONTEXT, propagation } = require('@opentelemetry/api')
const { storage } = require('../../../datadog-core')
const { getAllBaggageItems, setBaggageItem, removeAllBaggageItems } = require('../baggage')

const tracer = require('../../')
const SpanContext = require('./span_context')

class ContextManager {
  constructor () {
    this._store = storage('opentelemetry')
  }

  // converts dd to otel
  active () {
    const store = this._store.getStore()
    const baseContext = store || ROOT_CONTEXT
    const activeSpan = tracer.scope().active()

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

    if (store && trace.getSpanContext(store) === ddContext._otelSpanContext) {
      return otelBaggages ? propagation.setBaggage(store, otelBaggages) : store
    }

    const wrappedContext = trace.setSpanContext(baseContext, ddContext._otelSpanContext)
    return otelBaggages ? propagation.setBaggage(wrappedContext, otelBaggages) : wrappedContext
  }

  // converts otel to dd
  with (context, fn, thisArg, ...args) {
    const span = trace.getSpan(context)
    const ddScope = tracer.scope()
    const run = () => {
      const cb = thisArg == null ? fn : fn.bind(thisArg)
      return this._store.run(context, cb, ...args)
    }
    const baggages = propagation.getBaggage(context)
    let baggageItems = []
    if (baggages) {
      baggageItems = baggages.getAllEntries()
    }
    removeAllBaggageItems()
    for (const baggage of baggageItems) {
      setBaggageItem(baggage[0], baggage[1].value)
    }
    if (span && span._ddSpan) return ddScope.activate(span._ddSpan, run)
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
