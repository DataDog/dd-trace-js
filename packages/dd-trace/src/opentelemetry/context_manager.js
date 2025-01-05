'use strict'

const { storage } = require('../../../datadog-core')
const { trace, ROOT_CONTEXT, propagation } = require('@opentelemetry/api')
const DataDogSpanContext = require('../opentracing/span_context')

const SpanContext = require('./span_context')
const tracer = require('../../')

class ContextManager {
  constructor () {
    this._store = storage('opentelemetry')
  }

  active () {
    const activeSpan = tracer.scope().active()
    const store = this._store.getStore()
    const context = (activeSpan && activeSpan.context()) || store || ROOT_CONTEXT

    if (!(context instanceof DataDogSpanContext)) {
      const span = trace.getSpan(context)
      // span instanceof NonRecordingSpan
      if (span && span._spanContext && span._spanContext._ddContext && span._spanContext._ddContext._baggageItems) {
        const baggages = span._spanContext._ddContext._baggageItems
        const entries = {}
        for (const [key, value] of Object.entries(baggages)) {
          entries[key] = { value }
        }
        const otelBaggages = propagation.createBaggage(entries)
        return propagation.setBaggage(context, otelBaggages)
      }
      return context
    }

    const baggages = JSON.parse(activeSpan.getAllBaggageItems())
    const entries = {}
    for (const [key, value] of Object.entries(baggages)) {
      entries[key] = { value }
    }
    const otelBaggages = propagation.createBaggage(entries)

    if (!context._otelSpanContext) {
      const newSpanContext = new SpanContext(context)
      context._otelSpanContext = newSpanContext
    }
    if (store && trace.getSpanContext(store) === context._otelSpanContext) {
      return otelBaggages
        ? propagation.setBaggage(store, otelBaggages)
        : store
    }
    const wrappedContext = trace.setSpanContext(store || ROOT_CONTEXT, context._otelSpanContext)
    return otelBaggages
      ? propagation.setBaggage(wrappedContext, otelBaggages)
      : wrappedContext
  }

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
    if (span && span._ddSpan) {
      // does otel always override datadog?
      span._ddSpan.removeAllBaggageItems()
      for (const baggage of baggageItems) {
        span._ddSpan.setBaggageItem(baggage[0], baggage[1].value)
      }
      return ddScope.activate(span._ddSpan, run)
    }
    // span instanceof NonRecordingSpan
    if (span && span._spanContext && span._spanContext._ddContext && span._spanContext._ddContext._baggageItems) {
      span._spanContext._ddContext._baggageItems = {}
      for (const baggage of baggageItems) {
        span._spanContext._ddContext._baggageItems[baggage[0]] = baggage[1].value
      }
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
