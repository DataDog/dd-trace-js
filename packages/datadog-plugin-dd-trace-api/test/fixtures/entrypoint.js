'use strict'

const assert = require('node:assert/strict')

require(process.env.DD_TRACE_TEST_ENTRYPOINT).init()

const api = require(process.env.DD_TRACE_TEST_API_PATH).get()
const span = api.startSpan('dd-trace-api.entrypoint')

assert.doesNotMatch(span.context().toTraceId(), /^0+$/)
