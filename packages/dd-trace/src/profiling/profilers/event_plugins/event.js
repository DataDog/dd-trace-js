const { AsyncLocalStorage } = require('async_hooks')
const TracingPlugin = require('../../../plugins/tracing')
const { performance } = require('perf_hooks')

// We are leveraging the TracingPlugin class for its functionality to bind
// start/error/finish methods to the appropriate diagnostic channels.
class EventPlugin extends TracingPlugin {
  constructor (eventHandler) {
    super()
    this.eventHandler = eventHandler
    this.store = new AsyncLocalStorage()
    this.entryType = this.constructor.entryType
  }

  start (startEvent) {
    this.store.enterWith({
      startEvent,
      startTime: performance.now()
    })
  }

  error () {
    this.store.getStore().error = true
  }

  finish () {
    const { startEvent, startTime, error } = this.store.getStore()
    if (error) {
      return // don't emit perf events for failed operations
    }
    const duration = performance.now() - startTime

    const context = this.activeSpan?.context()
    const _ddSpanId = context?.toSpanId()
    const _ddRootSpanId = context?._trace.started[0]?.context().toSpanId() || _ddSpanId

    const event = {
      entryType: this.entryType,
      startTime,
      duration,
      _ddSpanId,
      _ddRootSpanId
    }
    this.eventHandler(this.extendEvent(event, startEvent))
  }
}

module.exports = EventPlugin
