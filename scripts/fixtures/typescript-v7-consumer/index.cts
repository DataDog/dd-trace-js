import tracer = require('dd-trace')
import formats = require('dd-trace/ext/formats')

const activeTracer = tracer.init({ service: 'consumer' })
activeTracer.trace('operation', () => formats.HTTP_HEADERS)
