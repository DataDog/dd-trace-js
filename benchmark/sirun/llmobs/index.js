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

// Mirrors ASCII_EVENTS one-for-one in shape (event count, message count per event,
// per-event total character length within ~5%) so the only meaningful delta is the
// non-ASCII content share — i.e. how often `encodeUnicode` takes the `code > 127`
// branch. Without that symmetry, the mixed-vs-ascii diff would also reflect event
// count and total payload size, not the replacer path.
const MIXED_EVENTS = [
  buildEvent({
    kind: 'llm',
    modelName: 'gpt-4o-2024-11-20',
    modelProvider: 'openai',
    input: [
      { role: 'system', content: 'あなたはオンコール対応のSREチームを支援する、親切で簡潔な日本語アシスタントです。回答は短い一文に収めて返してください。' },
      {
        role: 'user',
        content: '添付された顧客サポートのスレッドを三つの箇条書きで簡潔に要約してください。問題が解決済みかどうかを明記し、' +
          '関連する発生時刻、担当者、影響を受けたサービス、および関連するチケット番号も短く含めてください。',
      },
    ],
    output: [
      {
        role: 'assistant',
        content: '・お客様は14:00 UTC頃からチェックアウトサービスで断続的な502エラーを報告。一部のリージョンで影響が特に大きく、' +
          '約十分間ごとに再発しており、関連するアラートも複数発火していました。\n' +
          '・オンコール担当者が14:42 UTCに前回のデプロイを安全にロールバックし、五分以内にエラーが停止したことを監視ダッシュボードと' +
          '合成テストの両方で確認しました。\n' +
          '・解決済み。再発防止のため、次回のデプロイ前にカナリアヘルスチェックを追加するフォローアップチケットを作成済みで、' +
          '関連チームに共有しレビュー優先度を上げ、来週中の対応で合意しています。担当は山田さん。',
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
        content: 'Напиши функцию на Node.js, которая читает JSON-файл и возвращает разобранное значение, ' +
          'либо undefined, если такого файла нет.',
      },
    ],
    output: [
      {
        role: 'assistant',
        content: 'Функция на Node.js: синхронно проверяем существование пути, читаем содержимое в кодировке utf8 и ' +
          'возвращаем разобранный JSON либо undefined, если файл отсутствует. 🚀',
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
        content: '请将下面这段产品介绍完整地翻译成中文，保持要点列表的项目符号格式，并完整保留结尾处的行动号召语气与标点。' +
          '请按原文逐条对应翻译，请勿在结果中增加任何额外的解释、注释或营销话术，也不要修改产品名称、版本号或者具体数字与日期。请注意保留原有顺序。',
      },
    ],
    output: [
      {
        role: 'assistant',
        content: '・实时可观测仪表板，配合可自定义的告警通知，全面覆盖多区域生产部署，并与现有的事件管理与可观测平台实现无缝衔接、稳定可靠。\n' +
          '・与一百多种主流开发工具的深度集成，包含 مراقبة 시스템 등 多种 다국어 환경 的统一监控，支持跨团队、跨语言、跨地域协同作业。\n' +
          '・故障检测时间平均缩短了百分之四十七，显著提升应急响应效率，并降低每一次事故对最终客户的可感知影响范围。\n\n' +
          '立即开启您的免费试用，亲身体验更智能、更高效的全方位可观测性能力！',
      },
    ],
    metadata: { temperature: 0.3, max_tokens: 320 },
    inputTokens: 128,
    outputTokens: 84,
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
