'use strict'

const TracingPlugin = require('../../../plugins/tracing')
const { performance } = require('perf_hooks')

// We are leveraging the TracingPlugin class for its functionality to bind
// start/error/finish methods to the appropriate diagnostic channels.
// TODO: Decouple this from TracingPlugin.
class EventPlugin extends TracingPlugin {
  #eventHandler
  #eventFilter
  #dataSymbol
  #entryType

  constructor (eventHandler, eventFilter) {
    super()
    this.#eventHandler = eventHandler
    this.#eventFilter = eventFilter
    this.#entryType = this.constructor.entryType
    this.#dataSymbol = Symbol(`dd-trace.profiling.event.${this.#entryType}.${this.constructor.operation}`)
  }

  start (ctx) {
    ctx[this.#dataSymbol] = performance.now()
  }

  error (ctx) {
    // We don't emit perf events for failed operations
    ctx[this.#dataSymbol] = undefined
  }

  finish (ctx) {
    const startTime = ctx[this.#dataSymbol]
    if (startTime === undefined) {
      return
    }
    ctx[this.#dataSymbol] = undefined

    if (this.ignoreEvent(ctx)) {
      return // don't emit perf events for ignored events
    }

    const duration = performance.now() - startTime
    const event = {
      entryType: this.#entryType,
      startTime,
      duration
    }

    if (!this.#eventFilter(event)) {
      return
    }

    const context = (ctx.currentStore?.span || this.activeSpan)?.context()
    event._ddSpanId = context?.toSpanId()
    event._ddRootSpanId = context?._trace.started[0]?.context().toSpanId() || event._ddSpanId

    this.#eventHandler(this.extendEvent(event, ctx))
  }

  ignoreEvent () {
    return false
  }
}

module.exports = EventPlugin
