'use strict'

const assert = require('node:assert/strict')
const {
  extractContentParts,
  getOpenAIModelProvider,
  getServerToolUsageMetrics,
  getHostedToolMessage,
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

  it('reads web searches from tool_usage over the item count', () => {
    const response = {
      output: [webSearchCall(), fileSearchCall()],
      tool_usage: { image_gen: { total_tokens: 0 }, web_search: { num_requests: 3 } },
    }
    assert.deepStrictEqual(getServerToolUsageMetrics(response), { webSearchCount: 3, storageSearchCount: 1 })
  })

  it('omits the metric when tool_usage reports zero web searches', () => {
    const response = { output: [webSearchCall()], tool_usage: { web_search: { num_requests: 0 } } }
    assert.deepStrictEqual(getServerToolUsageMetrics(response), {})
  })

  for (const toolUsage of [undefined, null, {}, { image_gen: { total_tokens: 0 } }, { web_search: {} }]) {
    it(`falls back to counting search actions when tool_usage is ${JSON.stringify(toolUsage)}`, () => {
      const response = { output: [webSearchCall(), webSearchCall('completed', 'open_page')], tool_usage: toolUsage }
      assert.deepStrictEqual(getServerToolUsageMetrics(response), { webSearchCount: 1 })
    })
  }
})

describe('getHostedToolMessage', () => {
  function assertToolMessage (item, name, args, result) {
    assert.deepStrictEqual(getHostedToolMessage(item), {
      role: 'assistant',
      content: '',
      toolCalls: [{ name, arguments: args, toolId: item.id, type: item.type }],
      toolResults: [{ name, result: JSON.stringify(result), toolId: item.id, type: 'tool_result' }],
    })
  }

  it('keeps the web search action as arguments and only url and title of each source', () => {
    assertToolMessage({
      id: 'ws_1',
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'search', query: 'q', sources: [{ type: 'url', url: 'https://a.test', title: 'A' }] },
    }, 'web_search', { type: 'search', query: 'q' }, {
      status: 'completed',
      sources: [{ url: 'https://a.test', title: 'A' }],
    })
  })

  it('keeps a failed web search without action or sources', () => {
    assertToolMessage({ id: 'ws_2', type: 'web_search_call', status: 'failed' }, 'web_search', {}, {
      status: 'failed',
    })
  })

  it('leaves file contents out of file search results', () => {
    assertToolMessage({
      id: 'fs_1',
      type: 'file_search_call',
      status: 'completed',
      queries: ['refund policy'],
      results: [{ file_id: 'file_1', filename: 'policy.pdf', score: 0.9, text: 'private contents', attributes: {} }],
    }, 'file_search', { queries: ['refund policy'] }, {
      status: 'completed',
      results: [{ file_id: 'file_1', filename: 'policy.pdf', score: 0.9 }],
    })
  })

  it('records code interpreter code, logs and an image placeholder', () => {
    assertToolMessage({
      id: 'ci_1',
      type: 'code_interpreter_call',
      status: 'completed',
      code: 'print(1)',
      container_id: 'cntr_1',
      outputs: [{ type: 'logs', logs: '1' }, { type: 'image', url: 'https://img.test/1.png' }],
    }, 'code_interpreter', { code: 'print(1)', container_id: 'cntr_1' }, {
      status: 'completed',
      outputs: ['1', '[image]'],
    })
  })

  it('records only allowlisted web search action keys', () => {
    assertToolMessage({
      id: 'ws_3',
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'open_page', url: 'https://a.test', page_text: 'full page body' },
    }, 'web_search', { type: 'open_page', url: 'https://a.test' }, { status: 'completed' })
  })

  it('caps each code interpreter logs output at 4096 characters', () => {
    assertToolMessage({
      id: 'ci_2',
      type: 'code_interpreter_call',
      status: 'completed',
      code: 'print(x)',
      container_id: 'cntr_1',
      outputs: [{ type: 'logs', logs: 'a'.repeat(4096) }, { type: 'logs', logs: 'b'.repeat(4097) }],
    }, 'code_interpreter', { code: 'print(x)', container_id: 'cntr_1' }, {
      status: 'completed',
      outputs: ['a'.repeat(4096), 'b'.repeat(4096)],
    })
  })
})
