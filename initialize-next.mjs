import './initialize.mjs'

import * as Module from 'module'

const require = Module.createRequire(import.meta.url)
const { API, onApiReady } = require('./packages/dd-trace/src/opentelemetry/api')
const tracer = require('.')

// Load Next's OTel span normalization hook without enabling the legacy plugin.
require('./packages/datadog-instrumentations/src/next')

// Next's native OTel spans own the server lifecycle, including fetch. Keep the
// native fetch span so distributed W3C context refers to an exported parent.
tracer.use('http', { server: false })
tracer.use('fetch', false)
tracer.use('next', false)

onApiReady(API, () => {
  new tracer.TracerProvider().register()
})
