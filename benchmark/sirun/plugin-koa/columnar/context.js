'use strict'

const id = require('./id')
const { exporter } = require('./exporter')

class SpanContext {
  constructor (childOf) {
    if (childOf) {
      this.spanId = id.single()
      this.parentId = childOf.spanId
      this.segment = childOf.segment
    } else {
      this.spanId = id.single()
      this.parentId = id.zero
      this.segment = new Segment(id.double())
    }
  }
}

class Segment {
  constructor (traceId) {
    this.traceId = traceId
    this.segmentId = id.single()

    exporter.segmentStart(this)
  }
}

module.exports = { SpanContext }
