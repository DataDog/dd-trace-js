'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const PrioritySampler = require('../../../packages/dd-trace/src/priority_sampler')
const DatadogSpanContext = require('../../../packages/dd-trace/src/opentracing/span_context')
const id = require('../../../packages/dd-trace/src/id')

const { VARIANT } = process.env
const ITERATIONS = Number(process.env.ITERATIONS) || 3_000_000

// Every trace runs PrioritySampler.sample() once at the root: it derives a
// priority from manual tags, sampling rules (glob match + deterministic Knuth
// hash + token-bucket rate limit), or agent-provided rates, then stamps the
// decision-maker tag. This is the per-trace sampling hot path. Build a real
// PrioritySampler and drive sample() over a corpus of real span contexts whose
// trace ids vary, so the Knuth hash stays unwarmed (a single reused id would
// hash to a constant and measure nothing).
const CONFIGS = {
  // Non-unit agent rate: forces the Knuth hash + formatKnuthRate, the common
  // case once the agent has reported per-service rates.
  agent: { rateLimit: 100 },
  // A matching rule: glob match, then rule.sample (hash + limiter).
  'rule-match': { rules: [{ service: 'web-*', sampleRate: 0.5, maxPerSecond: 100 }], rateLimit: 100 },
  // Several non-matching rules: measures the glob-miss scan before falling back
  // to the agent decision.
  'rule-miss': {
    rules: [
      { service: 'cron-*', sampleRate: 0.1 },
      { name: 'redis.*', sampleRate: 0.2 },
      { resource: 'GET /health', sampleRate: 0 },
    ],
    rateLimit: 100,
  },
  // A keep-everything rule capped at 1/s: after the first token the limiter
  // rejects, exercising the USER_REJECT + decision-maker-removal branch.
  'rate-limited': { rules: [{ service: 'web-*', sampleRate: 1, maxPerSecond: 1 }], rateLimit: 1 },
}

const config = CONFIGS[VARIANT]
assert.ok(config, `unknown VARIANT: ${VARIANT}`)

const sampler = new PrioritySampler('production', config)
// The agent variant needs non-default per-service rates so the non-unit Knuth
// path runs instead of the rate===1 short circuit.
if (VARIANT === 'agent') {
  sampler.update({ 'service:web-app,env:production': 0.5 })
}

// A corpus of real span contexts with distinct trace ids. Each carries the tag
// surface the rule locators read (service/resource/name). The span wrapper
// exposes context()/tracer() and is its own trace root.
const CORPUS_SIZE = 64
const tracer = { _service: 'web-app' }
const spans = []
for (let i = 0; i < CORPUS_SIZE; i++) {
  const spanContext = new DatadogSpanContext({
    traceId: id(),
    spanId: id(),
    name: 'web.request',
    tags: { service: 'web-app', resource: 'GET /api/v2/orders' },
  })
  const span = {
    _spanContext: spanContext,
    context () { return spanContext },
    tracer () { return tracer },
  }
  spanContext._trace.started.push(span)
  spans.push(span)
}

function sampleOnce (span) {
  // Reset the per-trace decision so sample() does the work again instead of
  // early-returning on an already-assigned priority.
  span.context()._sampling.priority = undefined
  sampler.sample(span)
  return span.context()._sampling.priority
}

// Preflight: confirm sample() actually assigns a priority (catches a refactor
// that turns the bench into a no-op early return).
const sampled = sampleOnce(spans[0])
assert.ok(sampled !== undefined, 'sample() did not assign a sampling priority')

guard.loopStart()
let sink = 0
for (let i = 0; i < ITERATIONS; i++) {
  sink += sampleOnce(spans[i % CORPUS_SIZE])
}
guard.done()

if (sink === undefined) throw new Error('unreachable')
