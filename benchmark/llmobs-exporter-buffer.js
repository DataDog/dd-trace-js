'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')

const benchmark = require('./benchmark')

const LLMObsExporter = proxyquire('../packages/dd-trace/src/exporters/llmobs', {
  '../../agent/info': { fetchAgentInfo () {} },
  '../../config/helper': { getValueFromEnvSources () {} },
  '../../log': { warn () {} },
})

const exporter = new LLMObsExporter({
  llmobs: { DD_LLMOBS_AGENTLESS_ENABLED: undefined },
  url: new URL('http://127.0.0.1:8126'),
}, {})

assert.ok(global.gc, 'run this benchmark with --expose-gc')

function createSpan (index) {
  const input = Buffer.alloc(11_250)
  input.writeUInt32LE(index)

  return {
    trace_id: String(index),
    span_id: String(index),
    parent_id: '0',
    name: 'benchmark',
    resource: 'benchmark',
    service: 'benchmark',
    type: 'llm',
    error: 0,
    meta: { language: 'javascript' },
    meta_struct: {
      _llmobs: {
        trace_id: String(index).padStart(32, '0'),
        tags: {
          service: 'benchmark',
          source: 'integration',
          ml_app: 'benchmark',
          language: 'javascript',
        },
        meta: {
          span: { kind: 'workflow' },
          input: { value: input.toString('base64') },
          output: { value: 'benchmark output' },
        },
        metrics: {},
        _dd: { sample_rate: '1', sampling_decision: '1' },
        name: 'benchmark',
        ml_app: 'benchmark',
      },
    },
    metrics: { _sampling_priority_v1: 1 },
    start: 0,
    duration: 1,
  }
}

function memoryUsage () {
  global.gc()
  global.gc()
  const { heapUsed, external, rss } = process.memoryUsage()
  return { heapUsed, external, rss }
}

function difference (after, before) {
  return {
    heapUsed: after.heapUsed - before.heapUsed,
    external: after.external - before.external,
    rss: after.rss - before.rss,
  }
}

const before = memoryUsage()
let spanSizeBytes
for (let i = 0; i < 1000; i++) {
  const span = createSpan(i)
  spanSizeBytes ??= Buffer.byteLength(JSON.stringify(span))
  exporter.export([span])
}
const atLimit = memoryUsage()

for (let i = 1000; i < 2000; i++) exporter.export([createSpan(i)])
const afterEviction = memoryUsage()

const bufferedSpans = exporter.getUncodedTraces().reduce((count, trace) => count + trace.length, 0)
assert.strictEqual(bufferedSpans, 1000)

process.stdout.write(`${JSON.stringify({
  spanSizeBytes,
  bufferedSpans,
  retainedAtLimit: difference(atLimit, before),
  retainedAfterEviction: difference(afterEviction, before),
})}\n`)

const trace = [createSpan(2000)]

benchmark('LLMObs exporter buffer')
  .add('evict oldest trace from a full 1,000-span buffer', () => {
    exporter.export(trace)
  })
  .run()
