'use strict'

require('dd-trace').init()

const { logs } = require('@opentelemetry/api-logs')
const { trace, context } = require('@opentelemetry/api')

const logger = logs.getLogger('otlp-logs-test', '1.0.0', {
  schemaUrl: 'https://opentelemetry.io/schemas/1.27.0',
})

logger.emit({
  severityText: 'INFO',
  body: 'plain message',
  attributes: { 'test.key': 'test.value' },
})

const spanContext = {
  traceId: '1234567890abcdef1234567890abcdef',
  spanId: '1234567890abcdef',
  traceFlags: 1,
}
context.with(trace.setSpan(context.active(), trace.wrapSpanContext(spanContext)), () => {
  logger.emit({
    severityText: 'ERROR',
    severityNumber: 17,
    body: 'correlated error message',
  })
})

// Give the HTTP exporter a moment to flush before exiting.
setTimeout(() => process.exit(0), 1000)
