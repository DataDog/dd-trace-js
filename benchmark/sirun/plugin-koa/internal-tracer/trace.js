'use strict'

const { channel } = require('diagnostics_channel')
const { encoder } = require('./encoder')
const { TraceContext } = require('./context')
const { storage } = require('../../../../packages/datadog-core')

const startChannel = channel('apm:koa:request:start')
const errorChannel = channel('apm:koa:request:error')
const asyncEndChannel = channel('apm:koa:request:async-end')

startChannel.subscribe(({ req }) => {
  const store = storage.getStore()
  const traceContext = new TraceContext(store.traceContext)

  store.traceContext = traceContext

  encoder.encodeWebRequestStart(req, 'koa')
})

errorChannel.subscribe(error => {
  encoder.encodeError(error)
})

asyncEndChannel.subscribe(({ res }) => {
  encoder.encodeWebRequestFinish(res, 'koa')

  // TODO: restore parent context
})
