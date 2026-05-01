'use strict'

const assert = require('node:assert/strict')

globalThis[Symbol.for('dd-trace')] ??= { beforeExitHandlers: new Set() }

// Stub the HTTP request module before the writer captures it. Flush still runs
// `_encode` end-to-end (the surface the perf PR optimises); the egress is replaced
// by a synchronous no-op so the bench measures only in-process work.
const requestPath = require.resolve('../../../packages/dd-trace/src/exporters/common/request')
require.cache[requestPath] = {
  id: requestPath,
  filename: requestPath,
  loaded: true,
  exports: function noopRequest (payload, options, callback) {
    if (callback) callback(null, '', 200)
  },
}

const LLMObsSpanWriter = require('../../../packages/dd-trace/src/llmobs/writers/spans')

const {
  VARIANT,
} = process.env

const ITERATIONS = 30_000

const writer = new LLMObsSpanWriter({
  apiKey: 'placeholder-api-key',
  site: 'datadoghq.com',
})
writer.setAgentless(true)
clearInterval(writer._periodic)

function buildEvent ({ kind, modelName, modelProvider, input, output, metadata, inputTokens, outputTokens }) {
  return {
    trace_id: '6b3b1c0c1b9e4f1a8c2e7d4a5b6c7d8e',
    span_id: '1234567890abcdef',
    parent_id: undefined,
    name: `${modelProvider}.${kind}`,
    tags: [
      'version:0.0.0',
      'env:bench',
      'service:llmobs-bench',
      `ml_app:${modelProvider}`,
      'language:javascript',
    ],
    start_ns: 1_415_926_535_897_000_000,
    duration: 750_000_000,
    status: 'ok',
    meta: {
      'span.kind': kind,
      model_name: modelName,
      model_provider: modelProvider,
      input: { messages: input },
      output: { messages: output },
      metadata,
    },
    metrics: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
    _dd: {
      span_id: '1234567890abcdef',
      trace_id: '6b3b1c0c1b9e4f1a8c2e7d4a5b6c7d8e',
    },
  }
}

const ASCII_EVENTS = [
  buildEvent({
    kind: 'llm',
    modelName: 'gpt-4o-2024-11-20',
    modelProvider: 'openai',
    input: [
      { role: 'system', content: 'You are a helpful assistant for an on-call SRE team.' },
      {
        role: 'user',
        content: 'Summarise the attached customer support thread in three bullet points and ' +
          'flag whether the issue is resolved.',
      },
    ],
    output: [
      {
        role: 'assistant',
        content: '- Customer reported intermittent 502 errors from the checkout service starting ' +
          'around 14:00 UTC.\n- On-call rolled back the previous deploy at 14:42 UTC and confirmed ' +
          'errors stopped within five minutes.\n- Resolved; follow-up ticket opened to add a canary ' +
          'health check before the next deploy.',
      },
    ],
    metadata: { temperature: 0.2, max_tokens: 512, top_p: 1, stream: false },
    inputTokens: 312,
    outputTokens: 96,
  }),
  buildEvent({
    kind: 'llm',
    modelName: 'claude-3-5-sonnet-20241022',
    modelProvider: 'anthropic',
    input: [
      {
        role: 'user',
        content: 'Write a Node.js function that reads a JSON file and returns the parsed value, ' +
          'returning undefined if the file does not exist.',
      },
    ],
    output: [
      {
        role: 'assistant',
        content: 'const fs = require(\'node:fs\')\n\nfunction readJsonOrUndefined (path) {\n  ' +
          'if (!fs.existsSync(path)) return undefined\n  return JSON.parse(fs.readFileSync(path, ' +
          '\'utf8\'))\n}',
      },
    ],
    metadata: { temperature: 0, max_tokens: 256 },
    inputTokens: 41,
    outputTokens: 64,
  }),
  buildEvent({
    kind: 'llm',
    modelName: 'gemini-1.5-pro-002',
    modelProvider: 'google',
    input: [
      {
        role: 'user',
        content: 'Translate the following product description into French, keeping the bullet ' +
          'points and preserving the trailing call to action.',
      },
    ],
    output: [
      {
        role: 'assistant',
        content: '- Tableau de bord en temps reel avec alertes personnalisables\n- Integration ' +
          'avec plus de 100 outils de developpement\n- Reduction moyenne de 47% du temps de ' +
          'detection des incidents\n\nDemarrez votre essai gratuit aujourd hui.',
      },
    ],
    metadata: { temperature: 0.3, max_tokens: 320 },
    inputTokens: 128,
    outputTokens: 84,
  }),
]

const MIXED_EVENTS = [
  buildEvent({
    kind: 'llm',
    modelName: 'gpt-4o-2024-11-20',
    modelProvider: 'openai',
    input: [{ role: 'user', content: 'お問い合わせありがとうございます。今日はどんなお手伝いが必要ですか？' }],
    output: [{ role: 'assistant', content: 'Здравствуйте! Чем я могу помочь? 🚀 你好，今天我可以为您做什么？' }],
    metadata: { temperature: 0.3 },
    inputTokens: 22,
    outputTokens: 28,
  }),
  buildEvent({
    kind: 'llm',
    modelName: 'claude-3-5-sonnet-20241022',
    modelProvider: 'anthropic',
    input: [{ role: 'user', content: 'Translate this paragraph to German: "Hello, world."' }],
    output: [{ role: 'assistant', content: 'Hallo, Welt. ¡Hola, mundo! Olá, mundo. مرحبا بالعالم.' }],
    metadata: { temperature: 0.2 },
    inputTokens: 18,
    outputTokens: 24,
  }),
]

const EVENTS = VARIANT === 'encode-unicode-mixed' ? MIXED_EVENTS : ASCII_EVENTS

// One pre-flight cycle to confirm the writer actually buffers and drains; catches a
// silent breakage where the writer config or stub hooked the wrong layer.
writer.append(EVENTS[0])
assert.equal(writer._buffer.events.length, 1)
writer.flush()
assert.equal(writer._buffer.events.length, 0)

for (let iteration = 0; iteration < ITERATIONS; iteration++) {
  for (const event of EVENTS) {
    writer.append(event)
  }
  writer.flush()
}
