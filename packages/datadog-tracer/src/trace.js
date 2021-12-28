'use strict'

const { id } = require('./id')
const { now } = require('./util')

class Trace {
  constructor ({ traceId, meta, metrics, origin, samplingPriority } = {}) {
    this.traceId = traceId || id()
    this.spans = []
    this.started = 0
    this.finished = 0
    this.samplingPriority = samplingPriority
    this.samplingMechanism = undefined
    this.meta = meta || {}
    this.metrics = metrics || {}
    this.origin = origin
    this.start = Date.now() * 1e6
    this.ticks = now()
  }
}

module.exports = { Trace }
