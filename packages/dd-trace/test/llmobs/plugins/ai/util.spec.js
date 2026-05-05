'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { getUsage } = require('../../../../src/llmobs/plugins/ai/util')

describe('llmobs/plugins/ai/util', () => {
  describe('getUsage', () => {
    it('reads AI SDK v4 promptTokens/completionTokens', () => {
      const usage = getUsage({
        'ai.usage.promptTokens': 10,
        'ai.usage.completionTokens': 5,
      })

      assert.deepEqual(usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    })

    it('reads AI SDK v5 inputTokens/outputTokens/totalTokens', () => {
      const usage = getUsage({
        'ai.usage.inputTokens': 100,
        'ai.usage.outputTokens': 25,
        'ai.usage.totalTokens': 125,
      })

      assert.deepEqual(usage, { inputTokens: 100, outputTokens: 25, totalTokens: 125 })
    })

    it('surfaces ai.usage.cachedInputTokens as cacheReadTokens without modifying inputTokens', () => {
      // AI SDK v5 reports `inputTokens` as the total prompt size (cached + non-cached),
      // and `cachedInputTokens` as the subset served from cache. Mirroring AI SDK
      // semantics, we keep `inputTokens` untouched.
      const usage = getUsage({
        'ai.usage.inputTokens': 12_447,
        'ai.usage.outputTokens': 294,
        'ai.usage.totalTokens': 12_741,
        'ai.usage.cachedInputTokens': 12_427,
      })

      assert.deepEqual(usage, {
        inputTokens: 12_447,
        outputTokens: 294,
        totalTokens: 12_741,
        cacheReadTokens: 12_427,
      })
    })

    it('falls back to providerMetadata.bedrock.usage for cache read/write tokens', () => {
      // Reproduces the customer scenario: AI SDK + @ai-sdk/amazon-bedrock with
      // prompt caching, where `ai.usage.cachedInputTokens` is not yet populated
      // by the bedrock provider but `providerMetadata.bedrock.usage` is.
      const usage = getUsage({
        'ai.usage.inputTokens': 12_447,
        'ai.usage.outputTokens': 294,
        'ai.usage.totalTokens': 12_741,
        'ai.response.providerMetadata': JSON.stringify({
          bedrock: {
            usage: {
              cacheReadInputTokens: 12_427,
              cacheWriteInputTokens: 0,
            },
          },
        }),
      })

      assert.deepEqual(usage, {
        inputTokens: 12_447,
        outputTokens: 294,
        totalTokens: 12_741,
        cacheReadTokens: 12_427,
        cacheWriteTokens: 0,
      })
    })

    it('reads anthropic cache fields from providerMetadata when present', () => {
      const usage = getUsage({
        'ai.usage.inputTokens': 2200,
        'ai.usage.outputTokens': 50,
        'ai.usage.totalTokens': 2250,
        'ai.response.providerMetadata': JSON.stringify({
          anthropic: {
            cacheReadInputTokens: 2000,
            cacheCreationInputTokens: 200,
          },
        }),
      })

      assert.deepEqual(usage, {
        inputTokens: 2200,
        outputTokens: 50,
        totalTokens: 2250,
        cacheReadTokens: 2000,
        cacheWriteTokens: 200,
      })
    })

    it('prefers ai.usage.cachedInputTokens over providerMetadata for cache reads', () => {
      const usage = getUsage({
        'ai.usage.inputTokens': 1000,
        'ai.usage.outputTokens': 10,
        'ai.usage.totalTokens': 1010,
        'ai.usage.cachedInputTokens': 800,
        'ai.response.providerMetadata': JSON.stringify({
          bedrock: { usage: { cacheReadInputTokens: 999, cacheWriteInputTokens: 50 } },
        }),
      })

      assert.deepEqual(usage, {
        inputTokens: 1000,
        outputTokens: 10,
        totalTokens: 1010,
        cacheReadTokens: 800,
        cacheWriteTokens: 50,
      })
    })

    it('omits cache metrics when there is no cache data', () => {
      const usage = getUsage({
        'ai.usage.inputTokens': 50,
        'ai.usage.outputTokens': 10,
        'ai.usage.totalTokens': 60,
      })

      assert.deepEqual(usage, { inputTokens: 50, outputTokens: 10, totalTokens: 60 })
    })

    it('ignores malformed providerMetadata JSON', () => {
      const usage = getUsage({
        'ai.usage.inputTokens': 50,
        'ai.usage.outputTokens': 10,
        'ai.usage.totalTokens': 60,
        'ai.response.providerMetadata': '{not-valid-json',
      })

      assert.deepEqual(usage, { inputTokens: 50, outputTokens: 10, totalTokens: 60 })
    })
  })
})
