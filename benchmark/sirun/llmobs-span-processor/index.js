'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

globalThis[Symbol.for('dd-trace')] ??= { beforeExitHandlers: new Set() }

const LLMObsSpanProcessor = require('../../../packages/dd-trace/src/llmobs/span_processor')
const LLMObsTagger = require('../../../packages/dd-trace/src/llmobs/tagger')
const DatadogSpanContext = require('../../../packages/dd-trace/src/opentracing/span_context')
const id = require('../../../packages/dd-trace/src/id')
const {
  SPAN_KIND,
  MODEL_NAME,
  MODEL_PROVIDER,
  METADATA,
  INPUT_MESSAGES,
  INPUT_VALUE,
  OUTPUT_MESSAGES,
  INPUT_DOCUMENTS,
  OUTPUT_DOCUMENTS,
  OUTPUT_VALUE,
  METRICS,
  ML_APP,
  NAME,
} = require('../../../packages/dd-trace/src/llmobs/constants/tags')

const { VARIANT } = process.env
const OPERATIONS = Number(process.env.OPERATIONS)

// Every finished LLMObs span runs through LLMObsSpanProcessor.format(): it reads
// the tagger's per-span tag map and the APM span tags, then builds the LLMObs
// event (meta/input/output by span kind, metrics, tags, error). This is the
// per-span LLMObs hot path, uncovered by the existing llmobs writer bench.
const processor = new LLMObsSpanProcessor({
  llmobs: { enabled: true },
  version: '1.0.0',
  env: 'bench',
  service: 'llmobs-bench',
  parsedDdTags: {},
})

const METRICS_VALUE = { input_tokens: 312, output_tokens: 96, total_tokens: 408 }

const CHAT_INPUT = [
  { role: 'system', content: 'You are a helpful assistant for an on-call SRE team.' },
  { role: 'user', content: 'Summarise the attached support thread in three bullet points.' },
]
const CHAT_OUTPUT = [
  { role: 'assistant', content: '- 502s started at 14:00 UTC.\n- Rolled back at 14:42.\n- Resolved.' },
]
const DOCS = [
  { text: 'Datadog APM traces requests across services.', name: 'apm', id: 'doc-1', score: 0.92 },
  { text: 'LLM Observability monitors model calls.', name: 'llmobs', id: 'doc-2', score: 0.81 },
]

const TAG_SETS = {
  'llm-chat': {
    [SPAN_KIND]: 'llm',
    [MODEL_NAME]: 'gpt-4o-2024-11-20',
    [MODEL_PROVIDER]: 'openai',
    [INPUT_MESSAGES]: CHAT_INPUT,
    [OUTPUT_MESSAGES]: CHAT_OUTPUT,
    [METADATA]: { temperature: 0.2, max_tokens: 512, top_p: 1, stream: false },
    [METRICS]: METRICS_VALUE,
    [ML_APP]: 'support-bot',
    [NAME]: 'openai.createChatCompletion',
  },
  embedding: {
    [SPAN_KIND]: 'embedding',
    [MODEL_NAME]: 'text-embedding-3-small',
    [MODEL_PROVIDER]: 'openai',
    [INPUT_DOCUMENTS]: DOCS,
    [OUTPUT_VALUE]: '[1536-dim vector]',
    [METRICS]: { input_tokens: 24 },
    [ML_APP]: 'search-index',
    [NAME]: 'openai.createEmbedding',
  },
  retrieval: {
    [SPAN_KIND]: 'retrieval',
    [INPUT_VALUE]: 'How does Datadog trace LLM calls?',
    [OUTPUT_DOCUMENTS]: DOCS,
    [METADATA]: { top_k: 2, index: 'docs-v2' },
    [ML_APP]: 'rag-pipeline',
    [NAME]: 'pinecone.query',
  },
  agent: {
    [SPAN_KIND]: 'agent',
    [INPUT_VALUE]: 'Investigate the deploy that broke checkout and summarise the fix.',
    [OUTPUT_VALUE]: 'Rolled back deploy 4821; checkout error rate back to baseline.',
    [METADATA]: { steps: 4, tools_used: ['search', 'rollback'] },
    [METRICS]: METRICS_VALUE,
    [ML_APP]: 'sre-agent',
    [NAME]: 'agent.run',
  },
}

const mlObsTags = TAG_SETS[VARIANT]
assert.ok(mlObsTags, `unknown VARIANT: ${VARIANT}`)

const spanContext = new DatadogSpanContext({
  traceId: id(),
  spanId: id(),
  tags: {},
})
spanContext._trace.tags['_dd.p.tid'] = '640cfd8d00000000'

const span = {
  _name: 'llmobs.span',
  _startTime: 1_716_950_000_000.5,
  _duration: 742.5,
  context () { return spanContext },
}
LLMObsTagger.tagMap.set(span, mlObsTags)

// Preflight: confirm format produced an event with the right kind and meta.
const sample = processor.format(span)
assert.equal(sample.meta['span.kind'], mlObsTags[SPAN_KIND], 'format did not set the span kind')
assert.ok(sample.tags.length > 0, 'format did not build the tag array')

guard.loopStart()
let sink = 0
for (let i = 0; i < OPERATIONS; i++) {
  const event = processor.format(span)
  sink += event.tags.length
}
guard.done()

if (sink === 0) throw new Error('unreachable')
