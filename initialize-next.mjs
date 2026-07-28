import './initialize.mjs'

import * as Module from 'module'

const require = Module.createRequire(import.meta.url)
const { API, onApiReady } = require('./packages/dd-trace/src/opentelemetry/api')
const tracer = require('.')

// Load Next's OTel span normalization hook without enabling the legacy plugin.
require('./packages/datadog-instrumentations/src/next')

// Next's native OTel spans own the server lifecycle. Keep dd-trace's HTTP client
// instrumentation for propagation and integrations that Next does not provide.
// eslint-disable-next-line eslint-rules/eslint-process-env
process.env.NEXT_OTEL_FETCH_DISABLED ??= '1'
tracer.use('http', { server: false })
tracer.use('next', false)

onApiReady(API, () => {
  new tracer.TracerProvider().register()
})
