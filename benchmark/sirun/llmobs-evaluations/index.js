'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

globalThis[Symbol.for('dd-trace')] ??= { beforeExitHandlers: new Set() }

// Stub the HTTP request module before the writer captures it, so flush runs
// `_encode` end-to-end (JSON.stringify with the encodeUnicode replacer) while the
// egress is a synchronous no-op. The existing `llmobs` bench covers the span
// writer; this covers the evaluation-metrics writer and its payload shape.
const requestPath = require.resolve('../../../packages/dd-trace/src/exporters/common/request')
require.cache[requestPath] = {
  id: requestPath,
  filename: requestPath,
  loaded: true,
  exports: function noopRequest (payload, options, callback) {
    if (callback) callback(null, '', 200)
  },
}

const LLMObsEvalMetricsWriter = require('../../../packages/dd-trace/src/llmobs/writers/evaluations')

const { VARIANT } = process.env
const OPERATIONS = Number(process.env.OPERATIONS)

const writer = new LLMObsEvalMetricsWriter({
  apiKey: 'placeholder-api-key',
  site: 'datadoghq.com',
})
writer.setAgentless(true)
clearInterval(writer._periodic)

function buildMetric ({ label, metricType, value, reasoning }) {
  const event = {
    join_on: { span: { span_id: '1234567890abcdef', trace_id: '6b3b1c0c1b9e4f1a8c2e7d4a5b6c7d8e' } },
    label,
    metric_type: metricType,
    ml_app: 'support-bot',
    [`${metricType}_value`]: value,
    timestamp_ms: 1_716_950_000_000,
    tags: ['version:1.0.0', 'env:bench', 'service:llmobs-bench', 'ml_app:support-bot'],
  }
  if (reasoning != null) event.reasoning = reasoning
  return event
}

const CATEGORICAL = [
  buildMetric({ label: 'sentiment', metricType: 'categorical', value: 'positive' }),
  buildMetric({ label: 'toxicity', metricType: 'categorical', value: 'none' }),
  buildMetric({ label: 'relevance', metricType: 'categorical', value: 'high' }),
]
const SCORE = [
  buildMetric({ label: 'faithfulness', metricType: 'score', value: 0.92 }),
  buildMetric({ label: 'answer_relevancy', metricType: 'score', value: 0.81 }),
  buildMetric({ label: 'context_precision', metricType: 'score', value: 0.77 }),
]
const REASONED_MIXED = [
  buildMetric({
    label: 'faithfulness',
    metricType: 'score',
    value: 0.92,
    reasoning: '回答は提供されたコンテキストに忠実で、事実誤認は見られませんでした。🚀 引用も正確です。',
  }),
  buildMetric({
    label: 'sentiment',
    metricType: 'categorical',
    value: 'positive',
    reasoning: 'Тон ответа доброжелательный и профессиональный, без признаков негатива.',
  }),
  buildMetric({
    label: 'relevance',
    metricType: 'categorical',
    value: 'high',
    reasoning: '答案与用户问题高度相关，覆盖了所有关键要点并保留了行动号召。',
  }),
]

const EVENTS = VARIANT === 'score' ? SCORE : (VARIANT === 'reasoned-mixed' ? REASONED_MIXED : CATEGORICAL)

// Preflight: confirm the writer buffers and drains.
writer.append(EVENTS[0])
assert.equal(writer._buffer.events.length, 1)
writer.flush()
assert.equal(writer._buffer.events.length, 0)

guard.loopStart()
for (let iteration = 0; iteration < OPERATIONS; iteration++) {
  for (const event of EVENTS) {
    writer.append(event)
  }
  writer.flush()
}
guard.done()
