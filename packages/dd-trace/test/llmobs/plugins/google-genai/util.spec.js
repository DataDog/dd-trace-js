'use strict'

const assert = require('node:assert')
const { describe, it } = require('mocha')

const { extractMetrics, formatOutputMessages } = require('../../../../src/llmobs/plugins/genai/util')

describe('google-genai llmobs util', () => {
  describe('extractMetrics', () => {
    it('derives totalTokens from prompt and candidate counts when totalTokenCount is absent', () => {
      const metrics = extractMetrics({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 } })
      assert.deepStrictEqual(metrics, { inputTokens: 5, outputTokens: 7, totalTokens: 12 })
    })

    it('prefers totalTokenCount over the derived sum when present', () => {
      const metrics = extractMetrics({
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 20 },
      })
      assert.deepStrictEqual(metrics, { inputTokens: 5, outputTokens: 7, totalTokens: 20 })
    })

    it('omits totalTokens when no token counts are present', () => {
      assert.deepStrictEqual(extractMetrics({ usageMetadata: {} }), {})
    })

    it('returns no metrics when usageMetadata is missing', () => {
      assert.deepStrictEqual(extractMetrics({}), {})
    })
  })

  describe('formatOutputMessages with streaming special cases', () => {
    function streamingResponse (part) {
      return { candidates: [{ content: { parts: [part] } }] }
    }

    it('routes a streaming functionCall part through non-streaming formatting', () => {
      const part = { functionCall: { name: 'getWeather', args: { city: 'NYC' }, id: 'call_1' } }
      assert.deepStrictEqual(formatOutputMessages(streamingResponse(part), true), [{
        role: 'assistant',
        toolCalls: [{ name: 'getWeather', arguments: { city: 'NYC' }, toolId: 'call_1', type: 'function_call' }],
      }])
    })

    it('routes a streaming executableCode part through non-streaming formatting', () => {
      const part = { executableCode: { language: 'PYTHON', code: 'print(1)' } }
      assert.deepStrictEqual(formatOutputMessages(streamingResponse(part), true), [{
        role: 'assistant',
        content: JSON.stringify({ language: 'PYTHON', code: 'print(1)' }),
      }])
    })

    it('routes a streaming codeExecutionResult part through non-streaming formatting', () => {
      const part = { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '1\n' } }
      assert.deepStrictEqual(formatOutputMessages(streamingResponse(part), true), [{
        role: 'assistant',
        content: JSON.stringify({ outcome: 'OUTCOME_OK', output: '1\n' }),
      }])
    })

    it('accumulates plain text streaming parts by role', () => {
      const response = { candidates: [{ content: { parts: [{ text: 'Hello, ' }, { text: 'world!' }] } }] }
      assert.deepStrictEqual(formatOutputMessages(response, true), [{ role: 'assistant', content: 'Hello, world!' }])
    })
  })
})
