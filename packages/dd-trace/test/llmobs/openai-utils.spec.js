'use strict'

const assert = require('node:assert/strict')
const { getOpenAIModelProvider } = require('../../src/llmobs/plugins/openai/utils')
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
