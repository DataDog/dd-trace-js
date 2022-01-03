'use strict'

const { channel } = require('diagnostics_channel')
const { tracer } = require('../../../../packages/datadog-tracer')
const { storage } = require('../../../../packages/datadog-core')

const startChannel = channel('apm:koa:request:start')
const errorChannel = channel('apm:koa:request:error')
const asyncEndChannel = channel('apm:koa:request:async-end')

startChannel.subscribe(({ req }) => {
  const type = 'web'
  const kind = 'server'
  const resource = `${req.method} ${req.url}`
  const meta = {
    'http.url': req.url,
    'http.status_code': '0',
    'http.method': req.method
  }

  const span = tracer.startSpan('koa.request', { resource, type, kind, meta })
  const store = storage.getStore()

  store.span = span
})

errorChannel.subscribe(error => {
  const { span } = storage.getStore()

  span.addError(error)
})

asyncEndChannel.subscribe(({ statusCode }) => {
  const { span } = storage.getStore()

  span.setTag('http.status_code', statusCode)
  span.finish()
})
