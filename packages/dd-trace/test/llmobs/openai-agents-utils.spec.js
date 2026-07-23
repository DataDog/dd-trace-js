'use strict'

const assert = require('node:assert/strict')
const {
  extractInputMessages,
  extractOutputMessages,
  extractMetrics,
  extractMetadata,
} = require('../../src/llmobs/plugins/openai-agents/utils')

describe('openai-agents utils', () => {
  describe('extractInputMessages', () => {
    it('prepends a system message when instructions are provided', () => {
      assert.deepStrictEqual(
        extractInputMessages('hello', 'You are helpful'),
        [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'hello' },
        ]
      )
    })

    it('treats a bare string input as a user message', () => {
      assert.deepStrictEqual(
        extractInputMessages('hi'),
        [{ role: 'user', content: 'hi' }]
      )
    })

    it('joins input_text and text parts on array message content', () => {
      const input = [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'foo ' },
          { type: 'text', text: 'bar' },
          { type: 'image_url', url: 'data:...' },
        ],
      }]
      assert.deepStrictEqual(
        extractInputMessages(input),
        [{ role: 'user', content: 'foo bar' }]
      )
    })

    it('skips array message items missing a role', () => {
      const input = [{ type: 'message', content: 'orphan' }]
      assert.deepStrictEqual(
        extractInputMessages(input),
        [{ role: 'user', content: '' }]
      )
    })

    it('drops array message items whose content is empty after extraction', () => {
      const input = [{ type: 'message', role: 'user', content: [] }]
      assert.deepStrictEqual(
        extractInputMessages(input),
        [{ role: 'user', content: '' }]
      )
    })

    it('accepts string content on array message items', () => {
      const input = [{ type: 'message', role: 'assistant', content: 'reply' }]
      assert.deepStrictEqual(
        extractInputMessages(input),
        [{ role: 'assistant', content: 'reply' }]
      )
    })

    it('parses function_call arguments as JSON when possible', () => {
      const input = [{
        type: 'function_call',
        call_id: 'c1',
        name: 'lookup',
        arguments: '{"q":"sf"}',
      }]
      const out = extractInputMessages(input)
      assert.strictEqual(out.length, 1)
      assert.strictEqual(out[0].role, 'assistant')
      assert.deepStrictEqual(out[0].toolCalls[0], {
        toolId: 'c1',
        name: 'lookup',
        arguments: { q: 'sf' },
        type: 'function_call',
      })
    })

    it('falls back to empty object args when function_call JSON is invalid', () => {
      const input = [{
        type: 'function_call',
        call_id: 'c2',
        name: 'lookup',
        arguments: '{not json}',
      }]
      const out = extractInputMessages(input)
      assert.deepStrictEqual(out[0].toolCalls[0].arguments, {})
    })

    it('preserves non-string function_call arguments verbatim', () => {
      const input = [{
        type: 'function_call',
        call_id: 'c3',
        name: 'lookup',
        arguments: { q: 'sf' },
      }]
      const out = extractInputMessages(input)
      assert.deepStrictEqual(out[0].toolCalls[0].arguments, { q: 'sf' })
    })

    it('extracts function_call_output items into a tool-result user message', () => {
      const input = [{
        type: 'function_call_output',
        call_id: 'c1',
        name: 'lookup',
        output: '72F',
      }]
      assert.deepStrictEqual(
        extractInputMessages(input),
        [{
          role: 'user',
          toolResults: [{
            toolId: 'c1',
            result: '72F',
            name: 'lookup',
            type: 'function_call_output',
          }],
        }]
      )
    })

    it('defaults function_call_output name to empty string when missing', () => {
      const input = [{ type: 'function_call_output', call_id: 'c1', output: '72F' }]
      const out = extractInputMessages(input)
      assert.strictEqual(out[0].toolResults[0].name, '')
    })

    it('returns a placeholder user message when input yields no messages', () => {
      assert.deepStrictEqual(
        extractInputMessages([]),
        [{ role: 'user', content: '' }]
      )
    })
  })

  describe('extractOutputMessages', () => {
    it('returns a placeholder when result is missing', () => {
      assert.deepStrictEqual(
        extractOutputMessages(undefined),
        [{ content: '', role: '' }]
      )
    })

    it('joins output_text parts and defaults role to assistant', () => {
      const result = {
        output: [{
          type: 'message',
          content: [
            { type: 'output_text', text: 'hello ' },
            { type: 'output_text', text: 'world' },
            { type: 'reasoning', text: 'ignored' },
          ],
        }],
      }
      assert.deepStrictEqual(
        extractOutputMessages(result),
        [{ role: 'assistant', content: 'hello world' }]
      )
    })

    it('accepts string content on message items', () => {
      const result = { output: [{ type: 'message', role: 'user', content: 'echo' }] }
      assert.deepStrictEqual(
        extractOutputMessages(result),
        [{ role: 'user', content: 'echo' }]
      )
    })

    it('extracts function_call output items into assistant toolCalls', () => {
      const result = {
        output: [{
          type: 'function_call',
          call_id: 'c1',
          name: 'lookup',
          arguments: '{"q":"sf"}',
        }],
      }
      const out = extractOutputMessages(result)
      assert.strictEqual(out[0].role, 'assistant')
      assert.deepStrictEqual(out[0].toolCalls[0], {
        toolId: 'c1',
        name: 'lookup',
        arguments: { q: 'sf' },
        type: 'function_call',
      })
    })

    it('swallows invalid function_call JSON arguments', () => {
      const result = {
        output: [{ type: 'function_call', call_id: 'c1', name: 'lookup', arguments: '{bad' }],
      }
      const out = extractOutputMessages(result)
      assert.deepStrictEqual(out[0].toolCalls[0].arguments, {})
    })

    it('preserves non-string function_call arguments verbatim', () => {
      const result = {
        output: [{ type: 'function_call', call_id: 'c1', name: 'lookup', arguments: { q: 'sf' } }],
      }
      const out = extractOutputMessages(result)
      assert.deepStrictEqual(out[0].toolCalls[0].arguments, { q: 'sf' })
    })
  })

  describe('extractMetrics', () => {
    it('returns undefined when usage is absent', () => {
      assert.strictEqual(extractMetrics({}), undefined)
      assert.strictEqual(extractMetrics(undefined), undefined)
    })

    it('returns undefined when usage carries no recognised counters', () => {
      assert.strictEqual(extractMetrics({ usage: {} }), undefined)
    })

    it('reads camelCase counters from usage', () => {
      const metrics = extractMetrics({
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      })
      assert.deepStrictEqual(metrics, {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      })
    })

    it('reads snake_case counters from usage', () => {
      const metrics = extractMetrics({
        usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
      })
      assert.deepStrictEqual(metrics, {
        inputTokens: 5,
        outputTokens: 7,
        totalTokens: 12,
      })
    })

    it('includes reasoning tokens from camelCase nested details', () => {
      const metrics = extractMetrics({
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          outputTokensDetails: { reasoningTokens: 3 },
        },
      })
      assert.strictEqual(metrics.reasoningOutputTokens, 3)
    })

    it('includes reasoning tokens from snake_case nested details', () => {
      const metrics = extractMetrics({
        usage: { output_tokens_details: { reasoning_tokens: 4 } },
      })
      assert.strictEqual(metrics.reasoningOutputTokens, 4)
    })

    it('omits a zero reasoning token count', () => {
      const metrics = extractMetrics({
        usage: { inputTokens: 1, outputTokens: 1, outputTokensDetails: { reasoningTokens: 0 } },
      })
      assert.ok(!('reasoningOutputTokens' in metrics))
    })

    it('derives totalTokens from input+output when total is missing', () => {
      const metrics = extractMetrics({ usage: { inputTokens: 4, outputTokens: 6 } })
      assert.strictEqual(metrics.totalTokens, 10)
    })

    it('omits totalTokens when input or output is missing', () => {
      const metrics = extractMetrics({ usage: { inputTokens: 4 } })
      assert.ok(!('totalTokens' in metrics))
    })
  })

  describe('extractMetadata', () => {
    it('returns undefined when response is missing', () => {
      assert.strictEqual(extractMetadata(undefined), undefined)
      assert.strictEqual(extractMetadata(null), undefined)
    })

    it('returns undefined when no recognised fields are set', () => {
      assert.strictEqual(extractMetadata({ unrelated: 1 }), undefined)
    })

    it('extracts recognised response config fields', () => {
      const md = extractMetadata({
        temperature: 0.7,
        max_output_tokens: 256,
        top_p: 1,
        tools: [{ name: 'lookup' }],
        tool_choice: 'auto',
        truncation: 'disabled',
      })
      assert.deepStrictEqual(md, {
        temperature: 0.7,
        max_output_tokens: 256,
        top_p: 1,
        tools: [{ name: 'lookup' }],
        tool_choice: 'auto',
        truncation: 'disabled',
      })
    })

    it('ignores undefined and null values', () => {
      const md = extractMetadata({ temperature: 0.5, top_p: null, tools: undefined })
      assert.deepStrictEqual(md, { temperature: 0.5 })
    })

    it('includes response.text when present', () => {
      const md = extractMetadata({ text: { format: { type: 'text' } } })
      assert.deepStrictEqual(md, { text: { format: { type: 'text' } } })
    })
  })
})
