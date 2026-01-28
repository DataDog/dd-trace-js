'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const {
  getTelemetryMetadata,
  getGenerationMetadata,
  getUsage,
  getJsonStringValue,
  getOperation,
  getLlmObsSpanName
} = require('../../../../src/llmobs/plugins/ai/util')

describe('ai plugin util', () => {
  describe('getTelemetryMetadata', () => {
    it('returns null when no telemetry metadata tags are present', () => {
      const tags = {
        'ai.model.id': 'gpt-4',
        'ai.settings.maxSteps': 5
      }

      assert.strictEqual(getTelemetryMetadata(tags), null)
    })

    it('extracts a single telemetry metadata key', () => {
      const tags = {
        'ai.telemetry.metadata.userId': '12345'
      }

      assert.deepStrictEqual(getTelemetryMetadata(tags), {
        userId: '12345'
      })
    })

    it('extracts multiple telemetry metadata keys', () => {
      const tags = {
        'ai.telemetry.metadata.userId': '12345',
        'ai.telemetry.metadata.sessionId': 'abc-123',
        'ai.telemetry.metadata.customField': 'value'
      }

      assert.deepStrictEqual(getTelemetryMetadata(tags), {
        userId: '12345',
        sessionId: 'abc-123',
        customField: 'value'
      })
    })

    it('ignores non-telemetry metadata tags', () => {
      const tags = {
        'ai.model.id': 'gpt-4',
        'ai.telemetry.metadata.userId': '12345',
        'ai.settings.maxSteps': 5,
        'ai.telemetry.functionId': 'myFunction'
      }

      assert.deepStrictEqual(getTelemetryMetadata(tags), {
        userId: '12345'
      })
    })

    it('handles various value types', () => {
      const tags = {
        'ai.telemetry.metadata.stringValue': 'hello',
        'ai.telemetry.metadata.numberValue': 42,
        'ai.telemetry.metadata.booleanValue': true
      }

      assert.deepStrictEqual(getTelemetryMetadata(tags), {
        stringValue: 'hello',
        numberValue: 42,
        booleanValue: true
      })
    })

    it('returns null for empty tags object', () => {
      assert.strictEqual(getTelemetryMetadata({}), null)
    })

    it('ignores tags with empty metadata key', () => {
      const tags = {
        'ai.telemetry.metadata.': 'value',
        'ai.telemetry.metadata.validKey': 'validValue'
      }

      assert.deepStrictEqual(getTelemetryMetadata(tags), {
        validKey: 'validValue'
      })
    })
  })

  describe('getGenerationMetadata', () => {
    it('returns null when no settings tags are present', () => {
      const tags = {
        'ai.model.id': 'gpt-4'
      }

      assert.strictEqual(getGenerationMetadata(tags), null)
    })

    it('extracts settings tags', () => {
      const tags = {
        'ai.settings.maxSteps': 5,
        'ai.settings.maxRetries': 3
      }

      assert.deepStrictEqual(getGenerationMetadata(tags), {
        maxSteps: 5,
        maxRetries: 3
      })
    })

    it('excludes model metadata keys from generation metadata', () => {
      const tags = {
        'ai.settings.maxSteps': 5,
        'ai.settings.temperature': 0.7
      }

      const result = getGenerationMetadata(tags)
      assert.strictEqual(result.maxSteps, 5)
      assert.strictEqual(result.temperature, undefined)
    })
  })

  describe('getUsage', () => {
    it('extracts v5 style usage tokens', () => {
      const tags = {
        'ai.usage.inputTokens': 100,
        'ai.usage.outputTokens': 50,
        'ai.usage.totalTokens': 150
      }

      assert.deepStrictEqual(getUsage(tags), {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150
      })
    })

    it('extracts v4 style usage tokens', () => {
      const tags = {
        'ai.usage.promptTokens': 100,
        'ai.usage.completionTokens': 50
      }

      assert.deepStrictEqual(getUsage(tags), {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150
      })
    })

    it('prefers v5 tokens over v4 tokens', () => {
      const tags = {
        'ai.usage.inputTokens': 200,
        'ai.usage.outputTokens': 100,
        'ai.usage.promptTokens': 100,
        'ai.usage.completionTokens': 50
      }

      const result = getUsage(tags)
      assert.strictEqual(result.inputTokens, 200)
      assert.strictEqual(result.outputTokens, 100)
    })
  })

  describe('getJsonStringValue', () => {
    it('parses valid JSON string', () => {
      const result = getJsonStringValue('{"key": "value"}', {})
      assert.deepStrictEqual(result, { key: 'value' })
    })

    it('returns default value for invalid JSON', () => {
      const result = getJsonStringValue('invalid json', { default: true })
      assert.deepStrictEqual(result, { default: true })
    })

    it('returns default value for undefined input', () => {
      const result = getJsonStringValue(undefined, 'default')
      assert.strictEqual(result, 'default')
    })
  })

  describe('getOperation', () => {
    it('extracts operation from span name', () => {
      const span = { _name: 'ai.generateText' }
      assert.strictEqual(getOperation(span), 'generateText')
    })

    it('extracts nested operation from span name', () => {
      const span = { _name: 'ai.generateText.doGenerate' }
      assert.strictEqual(getOperation(span), 'doGenerate')
    })

    it('returns undefined for span without name', () => {
      const span = { _name: '' }
      assert.strictEqual(getOperation(span), undefined)
    })
  })

  describe('getLlmObsSpanName', () => {
    it('returns operation only when no functionId', () => {
      assert.strictEqual(getLlmObsSpanName('generateText', undefined), 'generateText')
    })

    it('combines functionId and operation', () => {
      assert.strictEqual(getLlmObsSpanName('generateText', 'myFunction'), 'myFunction.generateText')
    })
  })
})
