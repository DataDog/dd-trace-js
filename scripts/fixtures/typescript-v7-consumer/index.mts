import tracer, { type Span, type TracerOptions } from 'dd-trace'

const options: TracerOptions = { service: 'consumer' }
const activeTracer = tracer.init(options)
const span: Span = activeTracer.startSpan('operation')
span.finish()
