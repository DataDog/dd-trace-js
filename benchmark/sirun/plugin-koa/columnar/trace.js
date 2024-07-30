'use strict'

const { tracingChannel } = require('diagnostics_channel')
const { encoder } = require('./encoder')
const { TraceContext } = require('./context')
const { storage } = require('../../../../packages/datadog-core')

const ch = tracingChannel('apm:koa:request')

ch.start.bindStore(storage, ({ req }) => {
  const traceContext = new TraceContext()

  encoder.encodeWebRequestStart(req, 'koa', traceContext)

  return traceContext
})

ch.end.bindStore(storage, ({ res }) => {
  const traceContext = storage.getStore()

  encoder.encodeWebRequestFinish(res, traceContext)

  return undefined
})

ch.subscribe({
  error: error => {
    encoder.encodeError(error, storage.getStore())
  }
})
