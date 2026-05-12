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
          return { modelProvider: 'amazon', modelName: 'titan' }
        },
        extractRequestParams: () => ({ temperature: 0, maxTokens: 0, prompt: '' }),
        extractTextAndResponseReason: () => ({ message: '', role: '', usage: {} }),
        extractTextAndResponseReasonFromStream: () => ({ message: '', role: '', usage: {} }),
      },
    })

    plugin = new BedrockRuntimePlugin({}, {
      llmobs: { enabled: true, mlApp: 'test' },
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

  it('ignores deserialize without an x-amzn-requestid header', () => {
    deserializeCh.publish({
      headers: { 'x-amzn-bedrock-input-token-count': '5' },
    })

    completeCh.publish(buildLlmComplete('not-the-leaked-id', 'amazon.titan'))

    sinon.assert.calledOnce(tagMetricsSpy)
    assert.deepStrictEqual(tagMetricsSpy.firstCall.args[1], emptyMetrics())
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
