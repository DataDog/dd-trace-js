'use strict'

const assert = require('node:assert/strict')
const {
  extractContentParts,
  getOpenAIModelProvider,
  getServerToolUsageMetrics,
} = require('../../src/llmobs/plugins/openai/utils')
const OpenAiLLMObsPlugin = require('../../src/llmobs/plugins/openai')
const { UNKNOWN_MODEL_PROVIDER } = require('../../src/llmobs/constants/tags')

describe('extractContentParts', () => {
  it('preserves empty text and formats every multimodal fallback', () => {
    assert.deepStrictEqual(extractContentParts([
      { type: 'text' },
      { type: 'image_url' },
      { type: 'input_audio' },
      { type: 'input_audio', input_audio: { data: 'aGVsbG8=', format: 'wav' } },
      null,
    ]), {
      content: '\n[image]\n[audio]\n[]',
      audioParts: [{ content: 'aGVsbG8=', mimeType: 'audio/wav' }],
    })
  })
})

describe('getOpenAIModelProvider', () => {
  it('returns openai for openai.com URLs', () => {
    assert.strictEqual(getOpenAIModelProvider('https://api.openai.com/v1'), 'openai')
  })

  it('returns azure_openai for Azure URLs', () => {
    assert.strictEqual(
      getOpenAIModelProvider('https://my-resource.openai.azure.com/openai'),
      'azure_openai'
    )
  })

  it('returns deepseek for DeepSeek URLs', () => {
    assert.strictEqual(getOpenAIModelProvider('https://api.deepseek.com/v1'), 'deepseek')
  })

  it('returns unknown provider for unrecognised URLs', () => {
    assert.strictEqual(getOpenAIModelProvider('http://127.0.0.1:9126/vcr/proxy'), UNKNOWN_MODEL_PROVIDER)
  })

  it('defaults to unknown provider for an empty string', () => {
    assert.strictEqual(getOpenAIModelProvider(''), UNKNOWN_MODEL_PROVIDER)
  })
})

describe('OpenAiLLMObsPlugin#_getModelProviderAndClient', () => {
  const call = (baseUrl) => OpenAiLLMObsPlugin.prototype._getModelProviderAndClient(baseUrl)

  it('maps Azure URLs to AzureOpenAI', () => {
    assert.deepStrictEqual(
      call('https://my-resource.openai.azure.com/openai'),
      { modelProvider: 'azure_openai', client: 'AzureOpenAI' }
    )
  })

  it('maps DeepSeek URLs to DeepSeek', () => {
    assert.deepStrictEqual(
      call('https://api.deepseek.com/v1'),
      { modelProvider: 'deepseek', client: 'DeepSeek' }
    )
  })

  it('maps openai.com URLs to OpenAI', () => {
    assert.deepStrictEqual(
      call('https://api.openai.com/v1'),
      { modelProvider: 'openai', client: 'OpenAI' }
    )
  })

  it('falls back to OpenAI client for unknown providers', () => {
    assert.deepStrictEqual(
      call('http://127.0.0.1:9126/vcr/proxy'),
      { modelProvider: UNKNOWN_MODEL_PROVIDER, client: 'OpenAI' }
    )
  })

  it('defaults baseUrl to empty string', () => {
    assert.deepStrictEqual(
      OpenAiLLMObsPlugin.prototype._getModelProviderAndClient(),
      { modelProvider: UNKNOWN_MODEL_PROVIDER, client: 'OpenAI' }
    )
  })
})

describe('getServerToolUsageMetrics', () => {
  const webSearchCall = (status = 'completed', actionType = 'search') =>
    ({ type: 'web_search_call', id: 'ws_1', status, action: { type: actionType } })
  const fileSearchCall = (status = 'completed', queries = ['company holiday policy']) =>
    ({ type: 'file_search_call', id: 'fs_1', status, queries, results: null })
  const message = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }

  it('omits metrics when there are no tool calls', () => {
    assert.deepStrictEqual(getServerToolUsageMetrics({ output: [message] }), {})
    assert.deepStrictEqual(getServerToolUsageMetrics({ output: [] }), {})
    assert.deepStrictEqual(getServerToolUsageMetrics({}), {})
    assert.deepStrictEqual(getServerToolUsageMetrics(), {})
  })

  it('omits metrics for chat completions, which have no output array', () => {
    assert.deepStrictEqual(getServerToolUsageMetrics({ choices: [{ message: { content: 'hi' } }] }), {})
  })

  it('counts both tools interleaved with messages', () => {
    // Observed real-world order: tool calls are not grouped ahead of the messages.
    const response = { output: [webSearchCall(), message, fileSearchCall(), message] }
    assert.deepStrictEqual(getServerToolUsageMetrics(response), { webSearchCount: 1, storageSearchCount: 1 })
  })

  it('counts only search actions', () => {
    // Observed on gpt-5: 2 search + 3 open_page items were billed as 2 searches.
    const response = {
      output: [
        webSearchCall('completed', 'search'),
        webSearchCall('completed', 'open_page'),
        webSearchCall('completed', 'open_page'),
        webSearchCall('completed', 'find_in_page'),
        webSearchCall('completed', 'search'),
      ],
    }
    assert.deepStrictEqual(getServerToolUsageMetrics(response), { webSearchCount: 2 })
  })

  it('omits the metric when only non-search actions are present', () => {
    const response = { output: [webSearchCall('completed', 'open_page'), webSearchCall('completed', 'find_in_page')] }
    assert.deepStrictEqual(getServerToolUsageMetrics(response), {})
  })

  it('counts a web search without an action', () => {
    const response = { output: [{ type: 'web_search_call', id: 'ws_1', status: 'completed' }] }
    assert.deepStrictEqual(getServerToolUsageMetrics(response), { webSearchCount: 1 })
  })

  it('counts a call with several queries once', () => {
    const response = { output: [fileSearchCall('completed', ['a', 'b', 'c'])] }
    assert.deepStrictEqual(getServerToolUsageMetrics(response), { storageSearchCount: 1 })
  })

  for (const status of ['in_progress', 'searching', 'incomplete', 'failed']) {
    it(`does not count calls with status ${status}`, () => {
      const response = { output: [webSearchCall(status), fileSearchCall(status)] }
      assert.deepStrictEqual(getServerToolUsageMetrics(response), {})
    })
  }

  it('does not count calls without a status', () => {
    const response = { output: [{ type: 'web_search_call' }, { type: 'file_search_call' }, null] }
    assert.deepStrictEqual(getServerToolUsageMetrics(response), {})
  })
})
