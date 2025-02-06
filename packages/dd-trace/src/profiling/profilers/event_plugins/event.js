'use strict'

const TracingPlugin = require('../../../plugins/tracing')
const { performance } = require('perf_hooks')

// We are leveraging the TracingPlugin class for its functionality to bind
// start/error/finish methods to the appropriate diagnostic channels.
// TODO: Decouple this from TracingPlugin.
class EventPlugin extends TracingPlugin {
  constructor (eventHandler, eventFilter) {
    super()
    this.eventHandler = eventHandler
    this.eventFilter = eventFilter
    this.contextData = new WeakMap()
    this.entryType = this.constructor.entryType
  }

  start (ctx) {
    this.contextData.set(ctx, {
      startEvent: ctx,
      startTime: performance.now()
    })
  }

  error (ctx) {
    const data = this.contextData.get(ctx)
    if (data) {
      data.error = true
    }
  }

  finish (ctx) {
    const data = this.contextData.get(ctx)

    if (!data) return

    const { startEvent, startTime, error } = data
    if (error || this.ignoreEvent(startEvent)) {
      return // don't emit perf events for failed operations or ignored events
    }

    const duration = performance.now() - startTime
    const event = {
      entryType: this.entryType,
      startTime,
      duration
    }

    if (!this.eventFilter(event)) {
      return
    }

    const context = (ctx.currentStore?.span || this.activeSpan)?.context()
    event._ddSpanId = context?.toSpanId()
    event._ddRootSpanId = context?._trace.started[0]?.context().toSpanId() || event._ddSpanId

    this.eventHandler(this.extendEvent(event, startEvent))
  }

  ignoreEvent () {
    return false
  }
}

module.exports = EventPlugin
