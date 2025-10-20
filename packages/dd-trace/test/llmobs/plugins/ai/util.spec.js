'use strict'

const { expect } = require('chai')
const { describe, it } = require('mocha')

const { getUsage } = require('../../../../src/llmobs/plugins/ai/util')

describe('AI Plugin Utils', () => {
  describe('getUsage', () => {
    it('should extract usage from v4 token properties', () => {
      const tags = {
        'ai.usage.promptTokens': 10,
        'ai.usage.completionTokens': 20
      }

      const result = getUsage(tags)

      expect(result).to.deep.equal({
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30
      })
    })

    it('should extract usage from v5 token properties', () => {
      const tags = {
        'ai.usage.inputTokens': 10,
        'ai.usage.outputTokens': 20,
        'ai.usage.totalTokens': 30
      }

      const result = getUsage(tags)

      expect(result).to.deep.equal({
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30
      })
    })

    it('should prefer v5 properties over v4', () => {
      const tags = {
        'ai.usage.inputTokens': 15,
        'ai.usage.promptTokens': 10,
        'ai.usage.outputTokens': 25,
        'ai.usage.completionTokens': 20,
        'ai.usage.totalTokens': 40
      }

      const result = getUsage(tags)

      expect(result).to.deep.equal({
        inputTokens: 15,
        outputTokens: 25,
        totalTokens: 40
      })
    })
  })
})
