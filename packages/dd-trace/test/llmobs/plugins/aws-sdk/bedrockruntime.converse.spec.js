'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

require('../../../setup/core')

const BedrockRuntimePlugin = require('../../../../src/llmobs/plugins/bedrockruntime')

// Drives the diagnostic channels directly with crafted Converse payloads to
// exercise the defensive content-block branches that cannot be recorded against
// live Bedrock: unsupported block types, an unsupported tool-result item, and
// malformed streamed tool-use JSON.
describe('BedrockRuntime LLMObs plugin converse content blocks', () => {
  const completeCh = dc.channel('apm:aws:request:complete:bedrockruntime')
  const streamedChunkCh = dc.channel('apm:aws:response:streamed-chunk:bedrockruntime')

  const modelId = 'anthropic.claude-3-haiku-20240307-v1:0'

  let plugin
  let tagLLMIOSpy
  let tagToolDefinitionsSpy

  beforeEach(() => {
    tagLLMIOSpy = sinon.spy()
    tagToolDefinitionsSpy = sinon.spy()

    plugin = new BedrockRuntimePlugin({}, {
      llmobs: { enabled: true, mlApp: 'test' },
      service: 'test',
    })
    plugin._tagger = {
      registerLLMObsSpan () {},
      tagMetadata () {},
      tagLLMIO: tagLLMIOSpy,
      tagMetrics () {},
      tagToolDefinitions: tagToolDefinitionsSpy,
    }
    plugin.configure({ enabled: true })
  })

  afterEach(() => {
    plugin.configure({ enabled: false })
  })

  it('labels unsupported content blocks and unsupported tool-result items (non-stream)', () => {
    completeCh.publish({
      currentStore: { span: {} },
      response: {
        request: {
          operation: 'converse',
          params: { modelId, messages: [{ role: 'user', content: [{ text: 'hi' }] }] },
        },
        $metadata: { requestId: 'req-converse' },
        output: {
          message: {
            role: 'assistant',
            content: [
              { toolResult: { toolUseId: 'tr-1', content: [{ weird: 1 }] } },
              { reasoningContent: {} },
            ],
          },
        },
        stopReason: 'end_turn',
        usage: { inputTokens: 3, outputTokens: 2 },
      },
    })

    sinon.assert.calledOnce(tagLLMIOSpy)
    const outputMessages = tagLLMIOSpy.firstCall.args[2]
    assert.deepStrictEqual(outputMessages, [{
      role: 'assistant',
      content: '[Unsupported content type: reasoningContent]',
      toolResults: [{
        name: '',
        result: '[Unsupported content type(s): weird]',
        toolId: 'tr-1',
        type: 'tool_result',
      }],
    }])
  })

  it('tolerates malformed streamed tool-use JSON (stream)', () => {
    const ctx = {
      currentStore: { span: {} },
      response: {
        request: { operation: 'converseStream', params: { modelId } },
        $metadata: { requestId: 'req-converse-stream' },
      },
    }

    const chunks = [
      { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 't-1', name: 'get_weather' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: 'not valid json{' } } } },
      { messageStop: { stopReason: 'tool_use' } },
    ]
    for (const chunk of chunks) streamedChunkCh.publish({ ctx, chunk })

    completeCh.publish(ctx)

    sinon.assert.calledOnce(tagLLMIOSpy)
    const outputMessages = tagLLMIOSpy.firstCall.args[2]
    assert.deepStrictEqual(outputMessages, [{
      role: 'assistant',
      // parseToolInput swallows the malformed JSON and emits empty arguments.
      toolCalls: [{ name: 'get_weather', arguments: {}, toolId: 't-1', type: 'toolUse' }],
    }])
  })
})
