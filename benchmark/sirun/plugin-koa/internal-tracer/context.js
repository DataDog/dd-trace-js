'use strict'

const { id, zeroId } = require('./id')

class TraceContext {
  constructor (childOf) {
    if (childOf) {
      this.traceId = childOf.traceId
      this.spanId = id()
      this.parentId = childOf.spanId
    } else {
      this.traceId = id()
      this.spanId = this.traceId
      this.parentId = zeroId
    }
  }
}

module.exports = { TraceContext }
