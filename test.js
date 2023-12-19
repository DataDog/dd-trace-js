const tracer = require('./packages/dd-trace').init({
  // tracePropagationStyle: {
  //   extract: ['tracecontext']
  // }
})
const { TracerProvider } = tracer
const provider = new TracerProvider()
provider.register()

const SpanContext = require('./packages/dd-trace/src/opentracing/span_context')

// const httpHeaders = {
//   'x-datadog-trace-id': '1234567890',
//   'x-datadog-parent-id': '9876543210',
//   'x-datadog-sampling-priority': '2',
//   'x-datadog-origin': 'synthetics',
//   'x-datadog-tags': '_dd.p.dm=-4,_dd.p.tid=0000000000000010'
// }

const spans = {}

const req = {
  body: {
    http_headers: [
      ['x-datadog-trace-id', '1234567890'],
      ['x-datadog-parent-id', '9876543210'],
      ['x-datadog-sampling-priority', '2'],
      ['x-datadog-origin', 'synthetics'],
      ['x-datadog-tags', '_dd.p.dm=-4,_dd.p.tid=0000000000000010']
    ]
  }
}

const request = req.body
let parent

if (request.parent_id) parent = spans[request.parent_id]

if (request.origin) {
  const traceId = parent?.traceId
  const parentId = parent?.parentId

  parent = new SpanContext({
    traceId,
    parentId
  })
  parent.origin = request.origin
}

const httpHeaders = request.http_headers || []
// Node.js HTTP headers are automatically lower-cased, simulate that here.
const convertedHeaders = {}
for (const [key, value] of httpHeaders) {
  convertedHeaders[key.toLowerCase()] = value
}
const extracted = tracer.extract('http_headers', convertedHeaders)
if (extracted !== null) parent = extracted

const span = provider.getTracer().startSpan(request.name, {
  type: request.type,
  resource: request.resource,
  childOf: parent,
  tags: {
    service: request.service
  }
})

console.log(span)
