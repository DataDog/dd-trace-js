import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const order = process.argv[2]
let api = order === 'cached-api-first' ? await import('@opentelemetry/api') : undefined
const tracer = process.env.NATIVE_OTEL ? undefined : require('dd-trace').init()
if (order === 'dependency-api-first') {
  const dependencyRequire = createRequire(process.argv[3])
  dependencyRequire('@opentelemetry/api')
}
if (order === 'api-first' || order === 'diag-first') {
  api = await import('@opentelemetry/api')
  if (order === 'diag-first') {
    api.diag.setLogger({ error () {}, warn () {}, info () {}, debug () {}, verbose () {} })
  }
}

const ended = []
const TracerProvider = tracer?.TracerProvider ?? require('@opentelemetry/sdk-trace-node').NodeTracerProvider
const provider = new TracerProvider({
  spanProcessors: [{
    onStart () {},
    /** @param {import('@opentelemetry/api').Span} span */
    onEnd (span) { ended.push(span) },
    shutdown () { return Promise.resolve() },
    forceFlush () { return Promise.resolve() },
  }],
})
provider.register()
api ??= await import('@opentelemetry/api')
assert.strictEqual(api.trace, (await import('@opentelemetry/api')).trace)

const startTime = Date.now()
await api.trace.getTracer('application').startActiveSpan('otel-sub', {
  startTime,
  attributes: { 'test.attribute': 'value' },
}, /** @param {import('@opentelemetry/api').Span} span */ async span => {
  assert.ok(span.isRecording())
  assert.ok(api.trace.isSpanContextValid(span.spanContext()))
  assert.strictEqual(api.trace.getActiveSpan(), span)
  const carrier = {}
  api.propagation.inject(api.context.active(), carrier)
  assert.strictEqual(span.spanContext().traceState?.serialize(), carrier.tracestate)
  const extracted = api.propagation.extract(api.ROOT_CONTEXT, carrier)
  assert.strictEqual(api.trace.getSpanContext(extracted).traceId, span.spanContext().traceId)
  assert.strictEqual(api.trace.getSpanContext(extracted).spanId, span.spanContext().spanId)
  assert.strictEqual(api.trace.getSpanContext(extracted).traceState?.serialize(), carrier.tracestate)
  await new Promise(resolve => setImmediate(resolve))
  assert.strictEqual(api.trace.getActiveSpan(), span)
  span.end(startTime + 50)
  assert.strictEqual(ended[0].spanContext().spanId, span.spanContext().spanId)
})
assert.strictEqual(api.trace.getActiveSpan(), undefined)
await provider.forceFlush()
await provider.shutdown()
