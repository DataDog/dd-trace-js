'use strict'

require('../setup/core')

const assert = require('node:assert')
const { describe, it, beforeEach } = require('mocha')

const { setGenAiApmTags, setGenAiApmUsageMetrics, updateGenAiApmTags } = require('../../src/llmobs/gen-ai-tags')

describe('gen_ai APM tags', () => {
  let span
  let tags

  beforeEach(() => {
    tags = {}
    const spanContext = {
      setTag (key, value) {
        tags[key] = value
      },
    }
    span = { context: () => spanContext }
  })

  it('writes every scalar for a model-backed kind', () => {
    setGenAiApmTags(span, {
      spanKind: 'llm',
      modelName: 'gpt-4',
      modelProvider: 'OpenAI',
      mlApp: 'my-app',
      sessionId: 'sess-1',
      metrics: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    })

    assert.deepStrictEqual(tags, {
      'gen_ai.operation.name': 'llm',
      'gen_ai.request.model': 'gpt-4',
      'gen_ai.provider.name': 'openai',
      'gen_ai.application.name': 'my-app',
      'gen_ai.conversation.id': 'sess-1',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 20,
      'gen_ai.usage.total_tokens': 30,
    })
  })

  it('defaults the model and provider for a model-backed kind without them', () => {
    setGenAiApmTags(span, { spanKind: 'embedding' })

    assert.deepStrictEqual(tags, {
      'gen_ai.operation.name': 'embedding',
      'gen_ai.request.model': 'custom',
      'gen_ai.provider.name': 'custom',
    })
  })

  it('keeps the model and provider for another kind, but does not default them', () => {
    setGenAiApmTags(span, { spanKind: 'agent', modelName: 'gpt-4o', modelProvider: 'OpenAI' })

    assert.deepStrictEqual(tags, {
      'gen_ai.operation.name': 'agent',
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.provider.name': 'openai',
    })

    tags = {}
    setGenAiApmTags(span, { spanKind: 'workflow' })

    assert.deepStrictEqual(tags, { 'gen_ai.operation.name': 'workflow' })
  })

  it('omits token usage for a kind that is not model-backed', () => {
    setGenAiApmTags(span, { spanKind: 'workflow', metrics: { input_tokens: 10 } })

    assert.deepStrictEqual(tags, { 'gen_ai.operation.name': 'workflow' })
  })

  it('writes only the fields an update carries, without defaulting the model', () => {
    updateGenAiApmTags(span, { spanKind: 'llm', sessionId: 'sess-1' })

    assert.deepStrictEqual(tags, {
      'gen_ai.operation.name': 'llm',
      'gen_ai.conversation.id': 'sess-1',
    })
  })

  it('accepts the camelCase metric spelling integrations extract', () => {
    setGenAiApmUsageMetrics(span, 'llm', {
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 5,
      reasoningOutputTokens: 6,
    })

    assert.deepStrictEqual(tags, {
      'gen_ai.usage.input_tokens': 1,
      'gen_ai.usage.output_tokens': 2,
      'gen_ai.usage.total_tokens': 3,
      'gen_ai.usage.cache_read_input_tokens': 4,
      'gen_ai.usage.cache_write_input_tokens': 5,
      'gen_ai.usage.reasoning_output_tokens': 6,
    })
  })

  it('skips metrics without a gen_ai counterpart and non-numeric values', () => {
    setGenAiApmUsageMetrics(span, 'llm', {
      cacheWrite5mTokens: 1,
      time_to_first_token: 2,
      input_tokens: '10',
      output_tokens: 20,
    })

    assert.deepStrictEqual(tags, { 'gen_ai.usage.output_tokens': 20 })
  })
})
