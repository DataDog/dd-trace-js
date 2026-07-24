'use strict'

const assert = require('node:assert/strict')
const { getOpenAIModelProvider } = require('../../src/llmobs/plugins/openai/utils')
const OpenAiLLMObsPlugin = require('../../src/llmobs/plugins/openai')
const { UNKNOWN_MODEL_PROVIDER } = require('../../src/llmobs/constants/tags')

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
