import './initialize.mjs'

import * as Module from 'module'

const require = Module.createRequire(import.meta.url)
const { API, onApiReady } = require('./packages/dd-trace/src/opentelemetry/api')
const tracer = require('.')

// Load Next's OTel span normalization hook without enabling the legacy plugin.
require('./packages/datadog-instrumentations/src/next')

// Keep Next's native fetch span visible so distributed W3C context refers to
// an exported parent. dd-trace's fetch integration keeps that span connected
// to the active Next request and provides Datadog propagation and HTTP tags.
tracer.use('http', { server: false })
tracer.use('next', false)

onApiReady(API, () => {
  new tracer.TracerProvider().register()
})
