'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../../setup/core')

// Drives the diagnostic channels directly so the cleanup behaviour is fast and
// dependency-free to verify. The integration counterpart is in
// `bedrockruntime.spec.js` (real SDK via VCR).
describe('BedrockRuntime LLMObs plugin pending token headers', () => {
  const deserializeCh = dc.channel('apm:aws:response:deserialize:bedrockruntime')
  const completeCh = dc.channel('apm:aws:request:complete:bedrockruntime')
  const streamedChunkCh = dc.channel('apm:aws:response:streamed-chunk:bedrockruntime')

  let BedrockRuntimePlugin
  let plugin
  let tagMetricsSpy

  beforeEach(() => {
    tagMetricsSpy = sinon.spy()

    // `usage: {}` keeps the response body free of tokens, so the only source
    // of token counts is the header cache. That makes the assertions sensitive
    // to whether a previous entry was correctly evicted.
    BedrockRuntimePlugin = proxyquire('../../../../src/llmobs/plugins/bedrockruntime', {
      '../../../../datadog-plugin-aws-sdk/src/services/bedrockruntime/utils': {
        parseModelId (modelId) {
          if (modelId.includes('embed')) return { modelProvider: 'amazon', modelName: 'embed' }
          const [modelProvider, modelName] = modelId.split('.')
          return { modelProvider, modelName }
        },
        extractRequestParams: () => ({ temperature: 0, maxTokens: 0, prompt: '' }),
        extractTextAndResponseReason: () => ({ message: '', role: '', usage: {} }),
        // the real one: the reduced path reads streamed token counts through it, and the shapes
        // it understands are the point of those tests
      },
    })

    plugin = new BedrockRuntimePlugin({}, {
      llmobs: { DD_LLMOBS_ENABLED: true, DD_LLMOBS_ML_APP: 'test' },
      service: 'test',
    })
    plugin._tagger = {
      registerLLMObsSpan () {},
      tagMetadata () {},
      tagLLMIO () {},
      tagMetrics: tagMetricsSpy,
    }
    plugin.configure({ enabled: true })
  })

  afterEach(() => {
    plugin.configure({ enabled: false })
  })

  it('drops pending headers when complete fires for a non-LLM operation', () => {
    publishDeserialize('req-non-llm', { input: 5, output: 3 })

    completeCh.publish({
      response: {
        request: { operation: 'getFoundationModel', params: {} },
        $metadata: { requestId: 'req-non-llm' },
      },
    })

    sinon.assert.notCalled(tagMetricsSpy)

    // Reusing the request id surfaces a leak: zero header tokens means the
    // previous :complete: cleaned the cache entry up.
    completeCh.publish(buildLlmComplete('req-non-llm', 'amazon.titan'))

    sinon.assert.calledOnce(tagMetricsSpy)
    assert.deepStrictEqual(tagMetricsSpy.firstCall.args[1], emptyMetrics())
  })

  it('drops pending headers when complete fires for an embedding model', () => {
    publishDeserialize('req-embed', { input: 5, output: 0 })

    completeCh.publish(buildLlmComplete('req-embed', 'amazon.embed-text'))

    sinon.assert.notCalled(tagMetricsSpy)

    completeCh.publish(buildLlmComplete('req-embed', 'amazon.titan'))

    sinon.assert.calledOnce(tagMetricsSpy)
    assert.deepStrictEqual(tagMetricsSpy.firstCall.args[1], emptyMetrics())
  })

  it('passes the pending headers through to the matching LLM span', () => {
    publishDeserialize('req-llm', { input: 7, output: 11, cacheRead: 2, cacheWrite: 1 })

    completeCh.publish(buildLlmComplete('req-llm', 'amazon.titan'))

    sinon.assert.calledOnce(tagMetricsSpy)
    assert.deepStrictEqual(tagMetricsSpy.firstCall.args[1], {
      // Input tokens are normalized to also count cached tokens.
      inputTokens: 7 + 2 + 1,
      outputTokens: 11,
      totalTokens: (7 + 2 + 1) + 11,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    })
  })

  it('caches nothing when the response reports no token counts', () => {
    deserializeCh.publish({ headers: { 'x-amzn-requestid': 'req-no-counts' } })

    completeCh.publish(buildLlmComplete('req-no-counts', 'amazon.titan'))

    sinon.assert.calledOnce(tagMetricsSpy)
    assert.deepStrictEqual(tagMetricsSpy.firstCall.args[1], emptyMetrics())
  })

  it('ignores deserialize without an x-amzn-requestid header', () => {
    deserializeCh.publish({
      headers: { 'x-amzn-bedrock-input-token-count': '5' },
    })

    completeCh.publish(buildLlmComplete('not-the-leaked-id', 'amazon.titan'))

    sinon.assert.calledOnce(tagMetricsSpy)
    assert.deepStrictEqual(tagMetricsSpy.firstCall.args[1], emptyMetrics())
  })

  describe('with LLM Observability disabled', () => {
    let apmTags

    beforeEach(() => {
      // the enabled plugin from the outer scope would consume the cached headers first
      plugin.configure({ enabled: false })

      plugin = new BedrockRuntimePlugin({}, {
        llmobs: { DD_LLMOBS_ENABLED: false },
        service: 'test',
      })
      plugin._tagger = { tagMetrics: tagMetricsSpy }
      plugin.configure({ enabled: true })

      apmTags = {}
    })

    it('tags the APM span with gen_ai attributes from the header token counts', () => {
      publishDeserialize('req-disabled', { input: 5, output: 3, cacheRead: 2, cacheWrite: 1 })
      completeCh.publish({
        ...buildLlmComplete('req-disabled', 'amazon.titan'),
        currentStore: { span: buildSpan() },
      })

      assert.deepStrictEqual(apmTags, {
        'gen_ai.operation.name': 'llm',
        'gen_ai.request.model': 'amazon.titan',
        'gen_ai.provider.name': 'amazon_bedrock',
        'gen_ai.usage.input_tokens': 8,
        'gen_ai.usage.output_tokens': 3,
        'gen_ai.usage.total_tokens': 11,
        'gen_ai.usage.cache_read_input_tokens': 2,
        'gen_ai.usage.cache_write_input_tokens': 1,
        '_dd.llmobs.artificial_gen_ai_tags': 'true',
      })
      sinon.assert.notCalled(tagMetricsSpy)
    })

    it('reads Converse usage off the response, which carries no token headers', () => {
      completeCh.publish({
        currentStore: { span: buildSpan() },
        response: {
          request: { operation: 'converse', params: { modelId: 'amazon.titan' } },
          $metadata: { requestId: 'req-converse' },
          usage: { inputTokens: 7, outputTokens: 2, cacheReadInputTokens: 1, cacheWriteInputTokens: 3 },
        },
      })

      assert.deepStrictEqual(apmTags, {
        'gen_ai.operation.name': 'llm',
        'gen_ai.request.model': 'amazon.titan',
        'gen_ai.provider.name': 'amazon_bedrock',
        // input tokens are normalized to also count cached tokens
        'gen_ai.usage.input_tokens': 11,
        'gen_ai.usage.output_tokens': 2,
        'gen_ai.usage.total_tokens': 13,
        'gen_ai.usage.cache_read_input_tokens': 1,
        'gen_ai.usage.cache_write_input_tokens': 3,
        '_dd.llmobs.artificial_gen_ai_tags': 'true',
      })
    })

    it('omits token usage for a Converse response whose usage object reports no counts', () => {
      completeCh.publish({
        currentStore: { span: buildSpan() },
        response: {
          request: { operation: 'converse', params: { modelId: 'amazon.titan' } },
          $metadata: { requestId: 'req-converse-empty' },
          usage: {},
        },
      })

      assert.deepStrictEqual(apmTags, {
        'gen_ai.operation.name': 'llm',
        'gen_ai.request.model': 'amazon.titan',
        'gen_ai.provider.name': 'amazon_bedrock',
        '_dd.llmobs.artificial_gen_ai_tags': 'true',
      })
    })

    it('writes only the counts a partial Converse usage object reports', () => {
      completeCh.publish({
        currentStore: { span: buildSpan() },
        response: {
          request: { operation: 'converse', params: { modelId: 'amazon.titan' } },
          $metadata: { requestId: 'req-converse-partial' },
          usage: { outputTokens: 4 },
        },
      })

      assert.deepStrictEqual(apmTags, {
        'gen_ai.operation.name': 'llm',
        'gen_ai.request.model': 'amazon.titan',
        'gen_ai.provider.name': 'amazon_bedrock',
        'gen_ai.usage.output_tokens': 4,
        'gen_ai.usage.total_tokens': 4,
        '_dd.llmobs.artificial_gen_ai_tags': 'true',
      })
    })

    // `invokeModelWithResponseStream` sends no token headers and no Converse metadata event; the
    // counts ride in the body of one chunk
    it('reads invokeModel stream usage off the invocation metrics chunk', () => {
      const ctx = buildStreamCtx('req-invoke-stream')

      streamedChunkCh.publish({ ctx, chunk: invokeModelChunk({ outputText: 'ignored' }) })
      streamedChunkCh.publish({
        ctx,
        chunk: invokeModelChunk({
          'amazon-bedrock-invocationMetrics': {
            inputTokenCount: 9,
            outputTokenCount: 4,
            cacheReadInputTokenCount: 2,
            cacheWriteInputTokenCount: 1,
          },
        }),
      })
      completeCh.publish(ctx)

      assert.deepStrictEqual(apmTags, {
        'gen_ai.operation.name': 'llm',
        'gen_ai.request.model': 'amazon.titan',
        'gen_ai.provider.name': 'amazon_bedrock',
        // input tokens are normalized to also count cached tokens
        'gen_ai.usage.input_tokens': 12,
        'gen_ai.usage.output_tokens': 4,
        'gen_ai.usage.total_tokens': 16,
        'gen_ai.usage.cache_read_input_tokens': 2,
        'gen_ai.usage.cache_write_input_tokens': 1,
        '_dd.llmobs.artificial_gen_ai_tags': 'true',
      })
    })

    // Amazon models report their counts as plain body fields rather than invocation metrics
    it('reads invokeModel stream usage off the Amazon token-count fields', () => {
      const ctx = buildStreamCtx('req-invoke-stream-amazon')

      streamedChunkCh.publish({
        ctx,
        chunk: invokeModelChunk({ outputText: 'hi', inputTextTokenCount: 6, totalOutputTextTokenCount: 2 }),
      })
      completeCh.publish(ctx)

      assert.equal(apmTags['gen_ai.usage.input_tokens'], 6)
      assert.equal(apmTags['gen_ai.usage.output_tokens'], 2)
      assert.equal(apmTags['gen_ai.usage.total_tokens'], 8)
    })

    // Anthropic reports its counts on the `message_start` body
    it('reads invokeModel stream usage off the Anthropic message usage', () => {
      const ctx = buildStreamCtx('req-invoke-stream-anthropic', 'anthropic.claude')

      streamedChunkCh.publish({
        ctx,
        chunk: invokeModelChunk({ type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } }),
      })
      streamedChunkCh.publish({
        ctx,
        chunk: invokeModelChunk({ type: 'message_delta', message: { usage: { input_tokens: 5, output_tokens: 3 } } }),
      })
      completeCh.publish(ctx)

      assert.equal(apmTags['gen_ai.usage.input_tokens'], 5)
      assert.equal(apmTags['gen_ai.usage.output_tokens'], 3)
      assert.equal(apmTags['gen_ai.usage.total_tokens'], 8)
    })

    // the counts are folded in as they arrive, so no frame is held until the response completes
    it('retains the running totals rather than the frames', () => {
      const ctx = buildStreamCtx('req-invoke-stream-retention')

      streamedChunkCh.publish({ ctx, chunk: invokeModelChunk({ outputText: 'lots of text' }) })
      streamedChunkCh.publish({ ctx, chunk: invokeModelChunk({ outputText: 'more text' }) })
      assert.equal(ctx.chunks, undefined)

      streamedChunkCh.publish({
        ctx,
        chunk: invokeModelChunk({ 'amazon-bedrock-invocationMetrics': { inputTokenCount: 3, outputTokenCount: 1 } }),
      })
      assert.equal(ctx.chunks, undefined)

      completeCh.publish(ctx)
      assert.equal(apmTags['gen_ai.usage.total_tokens'], 4)
    })

    // Amazon reports its counts on a frame that also carries text, and more text can follow; the
    // later frame must not overwrite what the earlier one measured
    it('keeps the counts a frame reported when a text-only frame follows', () => {
      const ctx = buildStreamCtx('req-invoke-stream-trailing-text')

      streamedChunkCh.publish({
        ctx,
        chunk: invokeModelChunk({ outputText: 'hello ', inputTextTokenCount: 6, totalOutputTextTokenCount: 2 }),
      })
      streamedChunkCh.publish({ ctx, chunk: invokeModelChunk({ outputText: 'world' }) })
      completeCh.publish(ctx)

      assert.equal(apmTags['gen_ai.usage.input_tokens'], 6)
      assert.equal(apmTags['gen_ai.usage.output_tokens'], 2)
      assert.equal(apmTags['gen_ai.usage.total_tokens'], 8)
    })

    it('omits usage for a streamed invokeModel whose chunks report no invocation metrics', () => {
      const ctx = buildStreamCtx('req-invoke-stream-none')

      streamedChunkCh.publish({ ctx, chunk: invokeModelChunk({ outputText: 'ignored' }) })
      completeCh.publish(ctx)

      assert.equal(apmTags['gen_ai.operation.name'], 'llm')
      assert.equal(apmTags['gen_ai.usage.total_tokens'], undefined)
    })

    it('survives a chunk whose body is not JSON', () => {
      const ctx = buildStreamCtx('req-invoke-stream-bad')

      const bytes = new TextEncoder().encode('amazon-bedrock-invocationMetrics: not json')
      streamedChunkCh.publish({ ctx, chunk: { chunk: { bytes } } })
      completeCh.publish(ctx)

      assert.equal(apmTags['gen_ai.usage.total_tokens'], undefined)
    })

    it('reads Converse stream usage off the metadata event', () => {
      const ctx = {
        currentStore: { span: buildSpan() },
        response: {
          request: { operation: 'converseStream', params: { modelId: 'amazon.titan' } },
          $metadata: { requestId: 'req-converse-stream' },
        },
      }

      streamedChunkCh.publish({ ctx, chunk: { contentBlockDelta: { delta: { text: 'ignored' } } } })
      streamedChunkCh.publish({ ctx, chunk: { metadata: { usage: { inputTokens: 4, outputTokens: 6 } } } })
      completeCh.publish(ctx)

      assert.deepStrictEqual(apmTags['gen_ai.usage.input_tokens'], 4)
      assert.deepStrictEqual(apmTags['gen_ai.usage.output_tokens'], 6)
      assert.deepStrictEqual(apmTags['gen_ai.usage.total_tokens'], 10)
    })

    it('omits token usage entirely when neither headers nor the response report any', () => {
      completeCh.publish({
        ...buildLlmComplete('req-no-usage', 'amazon.titan'),
        currentStore: { span: buildSpan() },
      })

      assert.deepStrictEqual(apmTags, {
        'gen_ai.operation.name': 'llm',
        'gen_ai.request.model': 'amazon.titan',
        'gen_ai.provider.name': 'amazon_bedrock',
        '_dd.llmobs.artificial_gen_ai_tags': 'true',
      })
    })

    it('omits token usage when the response carries no token-count headers', () => {
      deserializeCh.publish({ headers: { 'x-amzn-requestid': 'req-headerless' } })
      completeCh.publish({
        ...buildLlmComplete('req-headerless', 'amazon.titan'),
        currentStore: { span: buildSpan() },
      })

      assert.deepStrictEqual(apmTags, {
        'gen_ai.operation.name': 'llm',
        'gen_ai.request.model': 'amazon.titan',
        'gen_ai.provider.name': 'amazon_bedrock',
        '_dd.llmobs.artificial_gen_ai_tags': 'true',
      })
    })

    it('skips a request whose model id the SDK never accepted', () => {
      completeCh.publish({
        currentStore: { span: buildSpan() },
        response: {
          request: { operation: 'invokeModel', params: {} },
          error: new Error('ValidationException: modelId is required'),
        },
      })

      assert.deepStrictEqual(apmTags, {})

      // a throw here would have disabled the plugin, so the next request must still be tagged
      completeCh.publish({
        ...buildLlmComplete('req-after-invalid', 'amazon.titan'),
        currentStore: { span: buildSpan() },
      })

      assert.equal(apmTags['gen_ai.operation.name'], 'llm')
    })

    it('emits nothing for an embedding model', () => {
      publishDeserialize('req-embed', { input: 5 })
      completeCh.publish({
        ...buildLlmComplete('req-embed', 'amazon.embed-text'),
        currentStore: { span: buildSpan() },
      })

      assert.deepStrictEqual(apmTags, {})
    })

    function buildStreamCtx (requestId, modelId = 'amazon.titan') {
      return {
        currentStore: { span: buildSpan() },
        response: {
          request: { operation: 'invokeModelWithResponseStream', params: { modelId } },
          $metadata: { requestId },
        },
      }
    }

    function buildSpan () {
      const spanContext = {
        _trace: { tags: {} },
        setTag (key, value) {
          apmTags[key] = value
        },
      }
      return { context: () => spanContext }
    }
  })

  function publishDeserialize (requestId, { input, output, cacheRead, cacheWrite } = {}) {
    const headers = { 'x-amzn-requestid': requestId }
    if (input != null) headers['x-amzn-bedrock-input-token-count'] = String(input)
    if (output != null) headers['x-amzn-bedrock-output-token-count'] = String(output)
    if (cacheRead != null) headers['x-amzn-bedrock-cache-read-input-token-count'] = String(cacheRead)
    if (cacheWrite != null) headers['x-amzn-bedrock-cache-write-input-token-count'] = String(cacheWrite)
    deserializeCh.publish({ headers })
  }

  function buildLlmComplete (requestId, modelId) {
    return {
      currentStore: { span: {} },
      response: {
        request: { operation: 'invokeModel', params: { modelId } },
        $metadata: { requestId },
      },
    }
  }

  function invokeModelChunk (body) {
    return { chunk: { bytes: new TextEncoder().encode(JSON.stringify(body)) } }
  }

  function emptyMetrics () {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }
  }
})
