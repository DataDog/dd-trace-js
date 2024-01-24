const otherSpan = {}
const span = tracer.scope().active()

const childOf = tracer.extract(someHeaders) // span context
tracer.startSpan('name', { childOf, links })

// 1 use case
otherSpan.addLink(span.context())

const otelSpan = {}

otherOtel.add_link(span.spanContext())
