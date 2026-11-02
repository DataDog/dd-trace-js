'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')

const guard = require('../startup-guard')
const StatsD = require('../statsd')

// Keep discovery pending to measure only the buffer, without network requests.
const LLMObsExporter = proxyquire('../../../packages/dd-trace/src/exporters/llmobs', {
  '../../agent/info': { fetchAgentInfo () {} },
  '../../config/helper': { getValueFromEnvSources () {} },
  '../../log': { warn () {} },
})

const exporter = new LLMObsExporter({
  llmobs: { DD_LLMOBS_AGENTLESS_ENABLED: undefined },
  url: new URL('http://127.0.0.1:8126'),
}, {})

assert.ok(global.gc, 'run this benchmark with --expose-gc')

/** @param {number} index */
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

const operations = Number(process.env.OPERATIONS)
assert.ok(Number.isInteger(operations) && operations >= 1000)
const statsd = new StatsD({ prefix: 'llmobs-exporter-buffer.' })
const before = memoryUsage()
guard.loopStart()
for (let i = 0; i < operations; i++) exporter.export([createSpan(i)])
guard.done()
const after = memoryUsage()

const bufferedSpans = exporter.getUncodedTraces().reduce((count, trace) => count + trace.length, 0)
assert.strictEqual(bufferedSpans, 1000)

for (const key of ['heapUsed', 'external', 'rss']) {
  statsd.gauge(`retained_${key}_bytes`, after[key] - before[key])
}
statsd.gauge('buffered_spans', bufferedSpans)
statsd.flush()
