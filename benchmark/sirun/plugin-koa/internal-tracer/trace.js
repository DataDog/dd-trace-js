'use strict'

const { channel } = require('diagnostics_channel')
const { Encoder } = require('./encoder')
const { storage } = require('../../../../packages/datadog-core')
const { id, zeroId } = require('./id')

const startChannel = channel('apm:koa:request:start')
const errorChannel = channel('apm:koa:request:error')
const asyncEndChannel = channel('apm:koa:request:async-end')

const encoder = new Encoder()

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

startChannel.subscribe(({ req }) => {
  const store = storage.getStore()
  const traceContext = new TraceContext(store.traceContext)

  store.traceContext = traceContext

  encoder.encodeKoaRequestStart(req)
})

errorChannel.subscribe(error => {
  encoder.encodeError(error)
})

asyncEndChannel.subscribe(res => {
  encoder.encodeKoaRequestFinish(res)

  // TODO: restore parent context
})
