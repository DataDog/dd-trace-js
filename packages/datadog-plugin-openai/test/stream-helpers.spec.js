'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { constructResponseResponseFromStreamedChunks } = require('../src/stream-helpers')

describe('Plugin', () => {
  describe('openai stream helpers', () => {
    describe('constructResponseResponseFromStreamedChunks', () => {
      const inProgress = { id: 'resp_1', model: 'gpt-4o-mini', status: 'in_progress', output: [] }

      it('returns the final response of a completed stream', () => {
        const completed = { id: 'resp_1', status: 'completed', output: [{ type: 'message' }] }
        const chunks = [
          { type: 'response.created', response: inProgress },
          { type: 'response.output_text.delta', output_index: 0, delta: 'Hello' },
          { type: 'response.completed', response: completed },
        ]

        assert.strictEqual(constructResponseResponseFromStreamedChunks(chunks), completed)
      })

      it('falls back to the latest snapshot with no output when the stream ends before any output', () => {
        const chunks = [{ type: 'response.created', response: inProgress }]

        assert.deepStrictEqual(constructResponseResponseFromStreamedChunks(chunks), inProgress)
      })

      it('keeps the text streamed before the stream ended early', () => {
        const chunks = [
          { type: 'response.created', response: inProgress },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', role: 'assistant', content: [] },
          },
          { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hel' },
          { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'lo' },
        ]

        assert.deepStrictEqual(constructResponseResponseFromStreamedChunks(chunks), {
          ...inProgress,
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] }],
        })
      })

      it('keeps completed items and partial tool call arguments streamed before the stream ended early', () => {
        const message = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking' }] }
        const chunks = [
          { type: 'response.created', response: inProgress },
          { type: 'response.output_item.done', output_index: 0, item: message },
          {
            type: 'response.output_item.added',
            output_index: 1,
            item: { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '' },
          },
          { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"city":' },
          { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"Paris"' },
        ]

        assert.deepStrictEqual(constructResponseResponseFromStreamedChunks(chunks).output, [
          message,
          { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"' },
        ])
      })

      it('does not mutate the chunks delivered to the application', () => {
        const item = { type: 'message', role: 'assistant', content: [] }
        const chunks = [
          { type: 'response.created', response: inProgress },
          { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hi' },
        ]

        constructResponseResponseFromStreamedChunks(chunks)

        assert.deepStrictEqual(item, { type: 'message', role: 'assistant', content: [] })
        assert.deepStrictEqual(inProgress.output, [])
      })
    })
  })
})
