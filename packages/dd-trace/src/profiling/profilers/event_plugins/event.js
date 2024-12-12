const { storage } = require('../../../../../datadog-core')
const TracingPlugin = require('../../../plugins/tracing')
const { performance } = require('perf_hooks')

// We are leveraging the TracingPlugin class for its functionality to bind
// start/error/finish methods to the appropriate diagnostic channels.
class EventPlugin extends TracingPlugin {
  constructor (eventHandler, eventFilter) {
    super()
    this.eventHandler = eventHandler
    this.eventFilter = eventFilter
    this.store = storage('profiling')
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

    const event = {
      entryType: this.entryType,
      startTime,
      duration
    }

    if (!this.eventFilter(event)) {
      return
    }

    const context = this.activeSpan?.context()
    event._ddSpanId = context?.toSpanId()
    event._ddRootSpanId = context?._trace.started[0]?.context().toSpanId() || event._ddSpanId

    this.eventHandler(this.extendEvent(event, startEvent))
  }
}

module.exports = EventPlugin
