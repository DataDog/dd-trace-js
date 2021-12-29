'use strict'

const { channel } = require('diagnostics_channel')
const { id, zeroId } = require('./id')
const { Trace } = require('./trace')
const { addTags, now, setTag } = require('./util')

const {
  SAMPLING_MECHANISM_MANUAL,
  USER_REJECT,
  USER_KEEP
} = require('./constants')

// TODO: channel(s) for updates
const startedChannel = channel('datadog:apm:span:started')
const finishedChannel = channel('datadog:apm:span:finished')

class Span {
  constructor (tracer, name, resource, { childOf, type, meta, metrics }) {
    if (childOf) {
      this.trace = childOf.trace
      this.spanId = id()
      this.parentId = childOf.spanId
      this.baggage = childOf.baggage
      this.start = this.trace.start + now() - this.trace.ticks
    } else {
      this.trace = new Trace()
      this.spanId = this.trace.traceId
      this.parentId = zeroId
      this.baggage = {}
      this.start = this.trace.start
    }

    this.tracer = tracer
    this.service = tracer.config.service
    this.name = name
    this.resource = resource
    this.error = 0
    this.meta = meta || {}
    this.metrics = metrics || {}
    this.duration = 0
    this.type = type || ''

    this.trace.started++

    startedChannel.publish(this)
  }

  setTag (key, value) {
    setTag(this, key, value)
  }

  setBaggageItem (key, value) {
    this.baggage = {
      ...this.baggage,
      [key]: value
    }
  }

  addTags (keyValuePairs) {
    addTags(this, keyValuePairs)
  }

  addError (error) {
    this.error = error
  }

  sample (keep = true) {
    if (this.trace.samplingPriority !== undefined) return

    this.trace.samplingPriority = keep ? USER_KEEP : USER_REJECT
    this.trace.samplingMechanism = SAMPLING_MECHANISM_MANUAL
  }

  finish (finishTime) {
    const trace = this.trace

    this.duration = finishTime
      ? finishTime - trace.start
      : now() - trace.ticks

    trace.finished++

    finishedChannel.publish(this)

    this.tracer.process(this)
  }
}

module.exports = { Span }
