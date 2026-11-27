'use strict'

const assert = require('node:assert/strict')
const dgram = require('node:dgram')
const { once } = require('node:events')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

require('../../../setup/core')

const DdTelemetryPlugin = require('../../../../src/llmobs/plugins/ai/ddTelemetry')
const VercelAiTelemetryPlugin = require('../../../../src/llmobs/plugins/ai/vercelTelemetry')

const PROVIDER_ATTEMPT = 'trajectory.profile:gen_ai.client.provider_attempt/0.1.0'
const TOKEN_BREAKDOWN = 'trajectory.profile:trajectory.gen_ai.client.token_breakdown/0.1.0'
const SENTINEL = 'usage-metrics-test.sentinel:1|c'

// `providerMetadata.gateway` as AI Gateway returns it, from
// https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering#provider-metadata-output,
// here for a call that fell back from Bedrock to Anthropic
const GATEWAY_METADATA = {
  routing: {
    originalModelId: 'anthropic/claude-sonnet-4.5',
    resolvedProvider: 'bedrock',
    resolvedProviderApiModelId: 'us.anthropic.claude-sonnet-4-5-v1:0',
    fallbacksAvailable: ['anthropic', 'vertex'],
    canonicalSlug: 'anthropic/claude-sonnet-4.5',
    finalProvider: 'anthropic',
    modelAttemptCount: 1,
    modelAttempts: [
      {
        modelId: 'bedrock:us.anthropic.claude-sonnet-4-5-v1:0',
        canonicalSlug: 'anthropic/claude-sonnet-4.5',
        success: true,
        providerAttemptCount: 2,
        providerAttempts: [
          {
            provider: 'bedrock',
            providerApiModelId: 'us.anthropic.claude-sonnet-4-5-v1:0',
            credentialType: 'system',
            success: false,
            error: 'Too Many Requests',
            startTime: 458753.407267,
            endTime: 458801.1,
          },
          {
            provider: 'anthropic',
            providerApiModelId: 'claude-sonnet-4-5-20250929',
            credentialType: 'system',
            success: true,
            startTime: 458801.1,
            endTime: 459891.705775,
          },
        ],
      },
    ],
    totalProviderAttemptCount: 2,
  },
  cost: '0.0045405',
  marketCost: '0.0045405',
  generationId: 'gen_01A2B3C4D5E6F7G8H9J0K1L2M',
}

const ROUTED_TAGS = [
  'gen_ai.operation.name:chat',
  'gen_ai.provider.name:anthropic',
  'gen_ai.request.model:anthropic/claude-sonnet-4.5',
  'trajectory.gateway.destination.id:anthropic:claude-sonnet-4-5-20250929',
  'trajectory.gateway.route:anthropic/claude-sonnet-4.5',
  'trajectory.observation.point:client',
]

/**
 * @param {string} profile
 * @param {string[]} tags
 */
function series (profile, ...tags) {
  return [profile, ...tags].sort().join(',')
}

/**
 * `providerMetadata.gateway` for a call AI Gateway served from its first choice.
 *
 * @param {string} provider
 * @param {string} providerApiModelId
 * @param {string} originalModelId
 */
function routedTo (provider, providerApiModelId, originalModelId) {
  return {
    routing: {
      originalModelId,
      resolvedProvider: provider,
      resolvedProviderApiModelId: providerApiModelId,
      finalProvider: provider,
      modelAttempts: [{ success: true, providerAttempts: [{ provider, providerApiModelId, success: true }] }],
    },
    cost: '0.01',
  }
}

const ANTHROPIC_MODEL = 'anthropic/claude-sonnet-4.5'
const ANTHROPIC = routedTo('anthropic', 'claude-sonnet-4-5-20250929', ANTHROPIC_MODEL)
const ANTHROPIC_ON_VERTEX = routedTo('vertex', 'claude-sonnet-4-5@20250929', ANTHROPIC_MODEL)
const BEDROCK = routedTo('bedrock', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', ANTHROPIC_MODEL)
const OPENAI_MODEL = 'openai/gpt-5'
const OPENAI = routedTo('openai', 'gpt-5', OPENAI_MODEL)
const GEMINI_MODEL = 'google/gemini-2.5-pro'
const GEMINI = routedTo('google', 'gemini-2.5-pro', GEMINI_MODEL)
const GEMINI_ON_VERTEX = routedTo('vertex', 'gemini-2.5-pro', GEMINI_MODEL)

// Anthropic's raw `usage` for 5,000 uncached input tokens and 3,000 read from the cache, as
// `providerMetadata.anthropic.usage` carries it
const ANTHROPIC_CACHE_READ_USAGE = {
  input_tokens: 5000,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 3000,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  output_tokens: 200,
  service_tier: 'standard',
}

// Gemini's raw `usageMetadata` for 5,000 input tokens, 3,000 of them cached, and 200 output tokens plus 800 thoughts
const GEMINI_USAGE_METADATA = {
  promptTokenCount: 5000,
  candidatesTokenCount: 200,
  thoughtsTokenCount: 800,
  cachedContentTokenCount: 3000,
  totalTokenCount: 6000,
}

/**
 * The token counts in flushed metrics, summed over their series, with the cache writes by lifetime.
 *
 * @param {object} flushed what `flushedMetrics` returns
 */
function tokenCounts (flushed) {
  const metrics = /** @type {Record<string, Record<string, { values: number[] }>>} */ (flushed)
  /** @param {number[]} values */
  const sum = values => values.reduce((a, b) => a + b, 0)
  /** @param {string} name */
  const total = name => metrics[name] && sum(Object.values(metrics[name]).flatMap(({ values }) => values))

  const cacheWrite = {}
  const writes = metrics['gen_ai.client.inference.usage.cache_write.input_tokens'] ?? {}
  for (const [key, { values }] of Object.entries(writes)) {
    const lifetime = key.split(',').find(tag => tag.startsWith('trajectory.cache.lifetime:'))?.split(':')[1]
    cacheWrite[lifetime] = sum(values)
  }

  return {
    input: total('gen_ai.client.inference.usage.input_tokens'),
    output: total('gen_ai.client.inference.usage.output_tokens'),
    cacheRead: total('gen_ai.client.inference.usage.cache_read.input_tokens'),
    cacheWrite,
  }
}

describe('vercel ai gateway usage metrics', () => {
  let socket
  let port
  let clock

  beforeEach(async () => {
    socket = dgram.createSocket('udp4')
    socket.bind(0, '127.0.0.1')
    await once(socket, 'listening')
    port = socket.address().port
    clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
  })

  afterEach(() => {
    clock.restore()
    socket.close()
  })

  /**
   * @param {boolean} enabled
   * @param {object} [ai]
   */
  function tracerConfig (enabled, ai = {}) {
    return {
      llmobs: { DD_LLMOBS_ENABLED: false },
      ai: { DD_AI_SDK_USAGE_METRICS_ENABLED: enabled, ...ai },
      dogstatsd: { hostname: '127.0.0.1', port },
      tags: { service: 'test-service', env: 'test' },
      service: 'test-service',
    }
  }

  /**
   * Flushes the metrics client, then returns the lines received before a sentinel this test sends itself, as
   * `{ [name]: { [sortedTags]: { type, values } } }`.
   */
  async function flushedMetrics () {
    const received = []
    const done = /** @type {Promise<void>} */ (new Promise(resolve => {
      socket.on('message', message => {
        for (const line of message.toString().split('\n')) {
          if (line === SENTINEL) return resolve()
          if (line) received.push(line)
        }
      })
    }))

    clock.tick(10_000)
    const sender = dgram.createSocket('udp4')
    sender.send(SENTINEL, port, '127.0.0.1', () => sender.close())
    await done

    const metrics = {}
    for (const line of received) {
      const [head, type, tags = ''] = line.split('|')
      const separator = head.lastIndexOf(':')
      const name = head.slice(0, separator)
      const key = tags.slice(1).split(',').sort().join(',')
      metrics[name] ??= {}
      metrics[name][key] ??= { type, values: [] }
      metrics[name][key].values.push(Number(head.slice(separator + 1)))
    }
    return metrics
  }

  describe('AI SDK 4 to 6 (OpenTelemetry spans)', () => {
    class TestDdTelemetryPlugin extends DdTelemetryPlugin {
      static prefix = 'tracing:dd-trace-usage-metrics-test:vercel-ai'
    }

    const startCh = dc.channel(`${TestDdTelemetryPlugin.prefix}:start`)
    const asyncEndCh = dc.channel(`${TestDdTelemetryPlugin.prefix}:asyncEnd`)

    let plugin

    afterEach(() => {
      plugin?.configure({ enabled: false })
    })

    /**
     * @param {boolean} enabled
     * @param {object} [ai]
     */
    function enable (enabled, ai) {
      plugin = new TestDdTelemetryPlugin({}, tracerConfig(enabled, ai))
      plugin.configure({ enabled: true })
    }

    /**
     * Runs one span the way the AI SDK does: start attributes, then the response attributes it sets before ending.
     *
     * @param {string} name
     * @param {Record<string, unknown>} startAttributes
     * @param {Record<string, unknown>} endAttributes
     * @param {{ durationMs?: number, error?: Error }} [options]
     */
    function runSpan (name, startAttributes, endAttributes, { durationMs = 1500, error } = {}) {
      const attributes = { ...startAttributes }
      const tags = {}
      const spanContext = {
        _trace: { tags: {} },
        getTags: () => attributes,
        getTag: () => undefined,
        setTag (key, value) { tags[key] = value },
      }
      const ctx = { name, attributes, currentStore: { span: { _name: name, context: () => spanContext } } }

      startCh.publish(ctx)
      clock.tick(durationMs)
      Object.assign(attributes, endAttributes)
      if (error) ctx.error = error
      asyncEndCh.publish(ctx)
    }

    const GATEWAY_START = {
      'ai.model.id': 'anthropic/claude-sonnet-4.5',
      'ai.model.provider': 'gateway',
    }

    // the attributes ai@6.0.322 sets on a doGenerate span through the gateway provider
    const GENERATE_END = {
      'ai.response.model': 'anthropic/claude-sonnet-4.5',
      'ai.response.providerMetadata': JSON.stringify({
        anthropic: { cacheCreationInputTokens: 1024 },
        gateway: GATEWAY_METADATA,
      }),
      'ai.usage.inputTokens': 4096,
      'ai.usage.outputTokens': 312,
      'ai.usage.totalTokens': 4408,
      'ai.usage.cachedInputTokens': 2048,
      'ai.usage.inputTokenDetails.cacheReadTokens': 2048,
      'ai.usage.inputTokenDetails.cacheWriteTokens': 1024,
    }

    it('records a buffered call with the usage and cost the gateway reports', async () => {
      enable(true)

      runSpan('ai.generateText.doGenerate', GATEWAY_START, GENERATE_END)

      const tags = [...ROUTED_TAGS, 'gen_ai.response.model:anthropic/claude-sonnet-4.5']
      assert.deepStrictEqual(await flushedMetrics(), {
        'gen_ai.client.inference.duration': {
          [series(PROVIDER_ATTEMPT, ...tags)]: { type: 'd', values: [1.5] },
        },
        'gen_ai.client.inference.duration.sum': {
          [series(PROVIDER_ATTEMPT, ...tags)]: { type: 'c', values: [1.5] },
        },
        'gen_ai.client.inference.duration.count': {
          [series(PROVIDER_ATTEMPT, ...tags)]: { type: 'c', values: [1] },
        },
        'gen_ai.client.inference.usage.input_tokens': {
          [series(PROVIDER_ATTEMPT, ...tags, 'gen_ai.token.modality:unknown')]: { type: 'c', values: [4096] },
        },
        'gen_ai.client.inference.usage.output_tokens': {
          [series(PROVIDER_ATTEMPT, ...tags, 'gen_ai.token.modality:unknown')]: { type: 'c', values: [312] },
        },
        'gen_ai.client.inference.usage.cache_read.input_tokens': {
          [series(TOKEN_BREAKDOWN, ...tags, 'gen_ai.token.modality:unknown')]: { type: 'c', values: [2048] },
        },
        'gen_ai.client.inference.usage.cache_write.input_tokens': {
          [series(
            TOKEN_BREAKDOWN, ...tags, 'gen_ai.token.modality:unknown', 'trajectory.cache.lifetime:unspecified'
          )]: { type: 'c', values: [1024] },
        },
        'trajectory.gen_ai.client.inference.usage.cost': {
          [series(PROVIDER_ATTEMPT, ...tags, 'trajectory.cost.source:reported')]: { type: 'c', values: [0.0045405] },
        },
      })
    })

    it('records a streamed call without cost metadata and leaves the cost out', async () => {
      enable(true, { DD_AI_SDK_USAGE_METRICS_CLIENT_SOURCE: 'Support Bot' })

      const { cost, marketCost, ...gateway } = GATEWAY_METADATA
      runSpan('ai.streamText.doStream', GATEWAY_START, {
        'ai.response.providerMetadata': JSON.stringify({ gateway }),
        'ai.usage.inputTokens': 20,
        'ai.usage.outputTokens': 7,
        'ai.usage.cachedInputTokens': 0,
      }, { durationMs: 2250 })

      const tags = [...ROUTED_TAGS, 'trajectory.client_source:support_bot']
      const metrics = await flushedMetrics()
      assert.deepStrictEqual(Object.keys(metrics).sort(), [
        'gen_ai.client.inference.duration',
        'gen_ai.client.inference.duration.count',
        'gen_ai.client.inference.duration.sum',
        'gen_ai.client.inference.usage.input_tokens',
        'gen_ai.client.inference.usage.output_tokens',
      ])
      assert.deepStrictEqual(metrics['gen_ai.client.inference.duration'], {
        [series(PROVIDER_ATTEMPT, ...tags)]: { type: 'd', values: [2.25] },
      })
      assert.deepStrictEqual(metrics['gen_ai.client.inference.usage.output_tokens'], {
        [series(PROVIDER_ATTEMPT, ...tags, 'gen_ai.token.modality:unknown')]: { type: 'c', values: [7] },
      })
    })

    it('records the duration of a failed call with its error type and no provider it cannot know', async () => {
      enable(true)

      class GatewayRateLimitError extends Error {}
      runSpan('ai.generateText.doGenerate', GATEWAY_START, {}, { error: new GatewayRateLimitError('slow down') })

      const tags = [
        'gen_ai.operation.name:chat',
        'gen_ai.request.model:anthropic/claude-sonnet-4.5',
        'trajectory.gateway.route:anthropic/claude-sonnet-4.5',
        'trajectory.observation.point:client',
        'error.type:gateway_rate_limit_error',
      ]
      const metrics = await flushedMetrics()
      assert.deepStrictEqual(Object.keys(metrics).sort(), [
        'gen_ai.client.inference.duration',
        'gen_ai.client.inference.duration.count',
        'gen_ai.client.inference.duration.sum',
      ])
      assert.deepStrictEqual(metrics['gen_ai.client.inference.duration'], {
        [series(PROVIDER_ATTEMPT, ...tags)]: { type: 'd', values: [1.5] },
      })
    })

    // these SDK versions hand `recordException` a plain object rather than the error itself
    it('names the error type of a failure recorded as a plain object', async () => {
      enable(true)

      const error = { name: 'AI_APICallError', message: 'Bad Request', stack: '' }
      runSpan('ai.generateText.doGenerate', GATEWAY_START, {}, { error })

      const metrics = await flushedMetrics()
      assert.deepStrictEqual(Object.keys(metrics['gen_ai.client.inference.duration']), [series(
        PROVIDER_ATTEMPT,
        'gen_ai.operation.name:chat',
        'gen_ai.request.model:anthropic/claude-sonnet-4.5',
        'trajectory.gateway.route:anthropic/claude-sonnet-4.5',
        'trajectory.observation.point:client',
        'error.type:ai_api_call_error'
      )])
    })

    it('records nothing for another provider or for the wrapping generateText span', async () => {
      enable(true)

      runSpan('ai.generateText.doGenerate', { 'ai.model.id': 'gpt-4o', 'ai.model.provider': 'openai.chat' }, {
        'ai.usage.inputTokens': 3,
        'ai.usage.outputTokens': 2,
      })
      runSpan('ai.generateText', GATEWAY_START, GENERATE_END)

      assert.deepStrictEqual(await flushedMetrics(), {})
    })

    describe('token accounting', () => {
      // What ai@5 (`@ai-sdk/gateway@2`, provider specification v2) records: each provider's own counts. A
      // `doGenerate` span names them `promptTokens` and `completionTokens` and leaves the cache to the metadata.
      const AI_SDK_5 = [
        {
          title: 'adds the cache reads Anthropic leaves out of the input tokens',
          model: ANTHROPIC_MODEL,
          span: 'ai.generateText.doGenerate',
          attributes: {
            'ai.usage.promptTokens': 5000,
            'ai.usage.completionTokens': 200,
            'ai.response.providerMetadata': JSON.stringify({
              anthropic: { usage: ANTHROPIC_CACHE_READ_USAGE, cacheCreationInputTokens: 0, stopSequence: null },
              gateway: ANTHROPIC,
            }),
          },
          expected: { input: 8000, output: 200, cacheRead: 3000, cacheWrite: {} },
        },
        {
          title: 'adds Anthropic cache writes and splits them by lifetime',
          model: ANTHROPIC_MODEL,
          span: 'ai.streamText.doStream',
          attributes: {
            'ai.usage.inputTokens': 12,
            'ai.usage.outputTokens': 80,
            'ai.usage.totalTokens': 92,
            'ai.usage.cachedInputTokens': 0,
            'ai.response.providerMetadata': JSON.stringify({
              anthropic: {
                usage: {
                  input_tokens: 12,
                  cache_creation_input_tokens: 4096,
                  cache_read_input_tokens: 0,
                  cache_creation: { ephemeral_5m_input_tokens: 1024, ephemeral_1h_input_tokens: 3072 },
                  output_tokens: 1,
                },
                cacheCreationInputTokens: 4096,
                stopSequence: null,
              },
              gateway: ANTHROPIC,
            }),
          },
          expected: { input: 4108, output: 80, cacheRead: undefined, cacheWrite: { '5m': 1024, '1h': 3072 } },
        },
        {
          title: 'adds the cache reads of Anthropic on Vertex from the routing alone',
          model: ANTHROPIC_MODEL,
          span: 'ai.streamText.doStream',
          attributes: {
            'ai.usage.inputTokens': 5000,
            'ai.usage.outputTokens': 200,
            'ai.usage.totalTokens': 5200,
            'ai.usage.cachedInputTokens': 3000,
            'ai.response.providerMetadata': JSON.stringify({ gateway: ANTHROPIC_ON_VERTEX }),
          },
          expected: { input: 8000, output: 200, cacheRead: 3000, cacheWrite: {} },
        },
        {
          title: 'does not add the cache again to Anthropic input tokens that already include it',
          model: ANTHROPIC_MODEL,
          span: 'ai.generateText.doGenerate',
          attributes: {
            'ai.usage.promptTokens': 8000,
            'ai.usage.completionTokens': 200,
            'ai.response.providerMetadata': JSON.stringify({
              anthropic: { usage: ANTHROPIC_CACHE_READ_USAGE, cacheCreationInputTokens: 0 },
              gateway: ANTHROPIC,
            }),
          },
          expected: { input: 8000, output: 200, cacheRead: 3000, cacheWrite: {} },
        },
        {
          title: 'adds the cache reads and writes Bedrock leaves out of the input tokens',
          model: ANTHROPIC_MODEL,
          span: 'ai.streamText.doStream',
          attributes: {
            'ai.usage.inputTokens': 5000,
            'ai.usage.outputTokens': 200,
            'ai.usage.totalTokens': 5200,
            'ai.usage.cachedInputTokens': 3000,
            'ai.response.providerMetadata': JSON.stringify({
              bedrock: { usage: { cacheWriteInputTokens: 1000 } },
              gateway: BEDROCK,
            }),
          },
          expected: { input: 9000, output: 200, cacheRead: 3000, cacheWrite: { unspecified: 1000 } },
        },
        {
          title: 'keeps OpenAI counts, which include cached input and reasoning',
          model: OPENAI_MODEL,
          span: 'ai.streamText.doStream',
          attributes: {
            'ai.usage.inputTokens': 5000,
            'ai.usage.outputTokens': 600,
            'ai.usage.totalTokens': 5600,
            'ai.usage.reasoningTokens': 400,
            'ai.usage.cachedInputTokens': 3000,
            'ai.response.providerMetadata': JSON.stringify({
              openai: { responseId: 'resp_1', serviceTier: 'default' },
              gateway: OPENAI,
            }),
          },
          expected: { input: 5000, output: 600, cacheRead: 3000, cacheWrite: {} },
        },
        {
          title: 'adds the thoughts Gemini leaves out of the output tokens',
          model: GEMINI_MODEL,
          span: 'ai.generateText.doGenerate',
          attributes: {
            'ai.usage.promptTokens': 5000,
            'ai.usage.completionTokens': 200,
            'ai.response.providerMetadata': JSON.stringify({
              google: { usageMetadata: GEMINI_USAGE_METADATA, groundingMetadata: null, safetyRatings: null },
              gateway: GEMINI_ON_VERTEX,
            }),
          },
          expected: { input: 5000, output: 1000, cacheRead: 3000, cacheWrite: {} },
        },
        {
          title: 'adds Gemini reasoning tokens from the routing alone',
          model: GEMINI_MODEL,
          span: 'ai.streamText.doStream',
          attributes: {
            'ai.usage.inputTokens': 5000,
            'ai.usage.outputTokens': 200,
            'ai.usage.totalTokens': 6000,
            'ai.usage.reasoningTokens': 800,
            'ai.usage.cachedInputTokens': 3000,
            'ai.response.providerMetadata': JSON.stringify({ gateway: GEMINI }),
          },
          expected: { input: 5000, output: 1000, cacheRead: 3000, cacheWrite: {} },
        },
      ]

      // What ai@6 (`@ai-sdk/gateway@3`, provider specification v3) records: totals that already include the cache
      // and reasoning, with their breakdown.
      const AI_SDK_6 = [
        {
          title: 'keeps Anthropic totals and splits cache writes by lifetime',
          model: ANTHROPIC_MODEL,
          attributes: {
            'ai.usage.inputTokens': 9000,
            'ai.usage.inputTokenDetails.noCacheTokens': 5000,
            'ai.usage.inputTokenDetails.cacheReadTokens': 3000,
            'ai.usage.inputTokenDetails.cacheWriteTokens': 1000,
            'ai.usage.outputTokens': 200,
            'ai.usage.totalTokens': 9200,
            'ai.usage.cachedInputTokens': 3000,
            'ai.response.providerMetadata': JSON.stringify({
              anthropic: {
                usage: {
                  input_tokens: 5000,
                  cache_creation_input_tokens: 1000,
                  cache_read_input_tokens: 3000,
                  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
                  output_tokens: 200,
                },
                cacheCreationInputTokens: 1000,
              },
              gateway: ANTHROPIC,
            }),
          },
          expected: { input: 9000, output: 200, cacheRead: 3000, cacheWrite: { '1h': 1000 } },
        },
        {
          title: 'keeps Bedrock totals and splits cache writes by lifetime',
          model: ANTHROPIC_MODEL,
          attributes: {
            'ai.usage.inputTokens': 9000,
            'ai.usage.inputTokenDetails.noCacheTokens': 5000,
            'ai.usage.inputTokenDetails.cacheReadTokens': 3000,
            'ai.usage.inputTokenDetails.cacheWriteTokens': 1000,
            'ai.usage.outputTokens': 200,
            'ai.usage.totalTokens': 9200,
            'ai.response.providerMetadata': JSON.stringify({
              bedrock: { usage: { cacheWriteInputTokens: 1000, cacheDetails: [{ ttl: '5m', inputTokens: 1000 }] } },
              gateway: BEDROCK,
            }),
          },
          expected: { input: 9000, output: 200, cacheRead: 3000, cacheWrite: { '5m': 1000 } },
        },
        {
          title: 'keeps OpenAI totals',
          model: OPENAI_MODEL,
          attributes: {
            'ai.usage.inputTokens': 5000,
            'ai.usage.inputTokenDetails.noCacheTokens': 2000,
            'ai.usage.inputTokenDetails.cacheReadTokens': 3000,
            'ai.usage.outputTokens': 600,
            'ai.usage.outputTokenDetails.textTokens': 200,
            'ai.usage.outputTokenDetails.reasoningTokens': 400,
            'ai.usage.totalTokens': 5600,
            'ai.response.providerMetadata': JSON.stringify({ openai: { responseId: 'resp_1' }, gateway: OPENAI }),
          },
          expected: { input: 5000, output: 600, cacheRead: 3000, cacheWrite: {} },
        },
        {
          title: 'does not add the thoughts again to Gemini totals',
          model: GEMINI_MODEL,
          attributes: {
            'ai.usage.inputTokens': 5000,
            'ai.usage.inputTokenDetails.noCacheTokens': 2000,
            'ai.usage.inputTokenDetails.cacheReadTokens': 3000,
            'ai.usage.outputTokens': 1000,
            'ai.usage.outputTokenDetails.textTokens': 200,
            'ai.usage.outputTokenDetails.reasoningTokens': 800,
            'ai.usage.totalTokens': 6000,
            'ai.response.providerMetadata': JSON.stringify({
              google: { usageMetadata: GEMINI_USAGE_METADATA },
              gateway: GEMINI_ON_VERTEX,
            }),
          },
          expected: { input: 5000, output: 1000, cacheRead: 3000, cacheWrite: {} },
        },
      ]

      for (const { title, model, span, attributes, expected } of AI_SDK_5) {
        it(`AI SDK 5: ${title}`, async () => {
          enable(true)

          runSpan(span, { 'ai.model.id': model, 'ai.model.provider': 'gateway' }, attributes)

          assert.deepStrictEqual(tokenCounts(await flushedMetrics()), expected)
        })
      }

      for (const { title, model, attributes, expected } of AI_SDK_6) {
        it(`AI SDK 6: ${title}`, async () => {
          enable(true)

          runSpan('ai.generateText.doGenerate', { 'ai.model.id': model, 'ai.model.provider': 'gateway' }, attributes)

          assert.deepStrictEqual(tokenCounts(await flushedMetrics()), expected)
        })
      }
    })

    it('records nothing when the metrics are disabled', async () => {
      enable(false)

      runSpan('ai.generateText.doGenerate', GATEWAY_START, GENERATE_END)

      assert.deepStrictEqual(await flushedMetrics(), {})
    })
  })

  describe('AI SDK 7 (telemetry tracing channel)', () => {
    class TestVercelAiPlugin extends VercelAiTelemetryPlugin {
      static prefix = 'tracing:ai-usage-metrics-test:telemetry'
    }

    const startCh = dc.channel(`${TestVercelAiPlugin.prefix}:start`)
    const asyncEndCh = dc.channel(`${TestVercelAiPlugin.prefix}:asyncEnd`)
    const chunkCh = dc.channel('dd-trace:vercel-ai:chunk')

    let plugin

    afterEach(() => {
      plugin?.configure({ enabled: false })
    })

    /**
     * @param {boolean} enabled
     */
    function enable (enabled) {
      plugin = new TestVercelAiPlugin({}, tracerConfig(enabled))
      plugin.configure({ enabled: true })
    }

    function buildCtx (event, isStream = false) {
      const spanContext = {
        _trace: { tags: {} },
        getTags: () => ({}),
        getTag: () => undefined,
        setTag () {},
      }
      return { type: 'languageModelCall', event, isStream, currentStore: { span: { context: () => spanContext } } }
    }

    const EVENT = { callId: 'call-1', modelId: 'anthropic/claude-sonnet-4.5', provider: 'gateway' }

    // what ai@7.0.162 publishes as a gateway languageModelCall's result: `doGenerate`'s, whose `response` the
    // gateway provider replaces with its headers and body, so it names no response model
    const GENERATE_RESULT = {
      content: [{ type: 'text', text: 'Hello' }],
      finishReason: { unified: 'stop', raw: 'end_turn' },
      usage: {
        inputTokens: { total: 4096, noCache: 1024, cacheRead: 2048, cacheWrite: 1024 },
        outputTokens: { total: 312, text: 312, reasoning: 0 },
      },
      providerMetadata: { anthropic: { cacheCreationInputTokens: 1024 }, gateway: GATEWAY_METADATA },
      response: { headers: {} },
    }

    it('records a buffered call with the usage and cost the gateway reports', async () => {
      enable(true)

      const ctx = buildCtx(EVENT)
      startCh.publish(ctx)
      clock.tick(800)
      ctx.result = GENERATE_RESULT
      asyncEndCh.publish(ctx)

      const metrics = await flushedMetrics()
      assert.deepStrictEqual(metrics['gen_ai.client.inference.duration'], {
        [series(PROVIDER_ATTEMPT, ...ROUTED_TAGS)]: { type: 'd', values: [0.8] },
      })
      assert.deepStrictEqual(metrics['gen_ai.client.inference.usage.input_tokens'], {
        [series(PROVIDER_ATTEMPT, ...ROUTED_TAGS, 'gen_ai.token.modality:unknown')]: { type: 'c', values: [4096] },
      })
      assert.deepStrictEqual(metrics['gen_ai.client.inference.usage.cache_read.input_tokens'], {
        [series(TOKEN_BREAKDOWN, ...ROUTED_TAGS, 'gen_ai.token.modality:unknown')]: { type: 'c', values: [2048] },
      })
      assert.deepStrictEqual(metrics['gen_ai.client.inference.usage.cache_write.input_tokens'], {
        [series(
          TOKEN_BREAKDOWN, ...ROUTED_TAGS, 'gen_ai.token.modality:unknown', 'trajectory.cache.lifetime:unspecified'
        )]: { type: 'c', values: [1024] },
      })
      assert.deepStrictEqual(metrics['trajectory.gen_ai.client.inference.usage.cost'], {
        [series(PROVIDER_ATTEMPT, ...ROUTED_TAGS, 'trajectory.cost.source:reported')]: {
          type: 'c',
          values: [0.0045405],
        },
      })
    })

    it('records a streamed call once its finish chunk arrives', async () => {
      enable(true)

      const ctx = buildCtx(EVENT, true)
      startCh.publish(ctx)
      // the call resolves with the stream before any chunk is read
      ctx.result = { stream: {} }
      asyncEndCh.publish(ctx)

      clock.tick(400)
      chunkCh.publish({
        ctx,
        chunk: { type: 'response-metadata', id: 'msg_1', modelId: 'claude-sonnet-4-5-20250929' },
        done: false,
      })
      chunkCh.publish({ ctx, chunk: { type: 'text-delta', id: '0', delta: 'Hi' }, done: false })
      clock.tick(600)
      const { cost, marketCost, ...gateway } = GATEWAY_METADATA
      chunkCh.publish({
        ctx,
        chunk: {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'end_turn' },
          usage: { inputTokens: { total: 20, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 7 } },
          providerMetadata: { gateway },
        },
        done: true,
      })
      ctx.streamConsumed = true
      asyncEndCh.publish(ctx)

      const tags = [...ROUTED_TAGS, 'gen_ai.response.model:claude-sonnet-4-5-20250929']
      assert.deepStrictEqual(await flushedMetrics(), {
        'gen_ai.client.inference.duration': {
          [series(PROVIDER_ATTEMPT, ...tags)]: { type: 'd', values: [1] },
        },
        'gen_ai.client.inference.duration.sum': {
          [series(PROVIDER_ATTEMPT, ...tags)]: { type: 'c', values: [1] },
        },
        'gen_ai.client.inference.duration.count': {
          [series(PROVIDER_ATTEMPT, ...tags)]: { type: 'c', values: [1] },
        },
        'gen_ai.client.inference.usage.input_tokens': {
          [series(PROVIDER_ATTEMPT, ...tags, 'gen_ai.token.modality:unknown')]: { type: 'c', values: [20] },
        },
        'gen_ai.client.inference.usage.output_tokens': {
          [series(PROVIDER_ATTEMPT, ...tags, 'gen_ai.token.modality:unknown')]: { type: 'c', values: [7] },
        },
      })
    })

    describe('token accounting', () => {
      // What ai@7 (`@ai-sdk/gateway@4`, provider specification v4) publishes: totals that already include the cache
      // and reasoning, with their breakdown.
      const AI_SDK_7 = [
        {
          title: 'keeps Anthropic totals and splits cache writes by lifetime',
          model: ANTHROPIC_MODEL,
          usage: {
            inputTokens: { total: 9000, noCache: 5000, cacheRead: 3000, cacheWrite: 1000 },
            outputTokens: { total: 200, text: 200, reasoning: undefined },
          },
          providerMetadata: {
            anthropic: {
              usage: {
                input_tokens: 5000,
                cache_creation_input_tokens: 1000,
                cache_read_input_tokens: 3000,
                cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 },
                output_tokens: 200,
              },
              cacheCreationInputTokens: 1000,
            },
            gateway: ANTHROPIC,
          },
          expected: { input: 9000, output: 200, cacheRead: 3000, cacheWrite: { '5m': 400, '1h': 600 } },
        },
        {
          title: 'keeps Bedrock totals',
          model: ANTHROPIC_MODEL,
          usage: {
            inputTokens: { total: 9000, noCache: 5000, cacheRead: 3000, cacheWrite: 1000 },
            outputTokens: { total: 200, text: 200, reasoning: undefined },
          },
          providerMetadata: { bedrock: { usage: { cacheWriteInputTokens: 1000 } }, gateway: BEDROCK },
          expected: { input: 9000, output: 200, cacheRead: 3000, cacheWrite: { unspecified: 1000 } },
        },
        {
          title: 'keeps OpenAI totals',
          model: OPENAI_MODEL,
          usage: {
            inputTokens: { total: 5000, noCache: 2000, cacheRead: 3000, cacheWrite: undefined },
            outputTokens: { total: 600, text: 200, reasoning: 400 },
          },
          providerMetadata: { openai: { responseId: 'resp_1' }, gateway: OPENAI },
          expected: { input: 5000, output: 600, cacheRead: 3000, cacheWrite: {} },
        },
        {
          title: 'keeps Gemini totals',
          model: GEMINI_MODEL,
          usage: {
            inputTokens: { total: 5000, noCache: 2000, cacheRead: 3000, cacheWrite: undefined },
            outputTokens: { total: 1000, text: 200, reasoning: 800 },
          },
          providerMetadata: { google: { usageMetadata: GEMINI_USAGE_METADATA }, gateway: GEMINI_ON_VERTEX },
          expected: { input: 5000, output: 1000, cacheRead: 3000, cacheWrite: {} },
        },
      ]

      for (const { title, model, usage, providerMetadata, expected } of AI_SDK_7) {
        it(`AI SDK 7: ${title}`, async () => {
          enable(true)

          const ctx = buildCtx({ callId: 'call-1', modelId: model, provider: 'gateway' })
          startCh.publish(ctx)
          ctx.result = {
            content: [{ type: 'text', text: 'Hello' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage,
            providerMetadata,
            response: { headers: {} },
          }
          asyncEndCh.publish(ctx)

          assert.deepStrictEqual(tokenCounts(await flushedMetrics()), expected)
        })
      }
    })

    it('records nothing when the metrics are disabled', async () => {
      enable(false)

      const ctx = buildCtx(EVENT)
      startCh.publish(ctx)
      ctx.result = GENERATE_RESULT
      asyncEndCh.publish(ctx)

      assert.deepStrictEqual(await flushedMetrics(), {})
    })
  })
})
