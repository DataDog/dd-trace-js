'use strict'

const assert = require('node:assert/strict')

const { getToolCallResultContent } = require('../../../../src/llmobs/plugins/ai/util')

const UNPARSABLE_TOOL_RESULT = '[Unparsable Tool Result]'
const UNSUPPORTED_TOOL_RESULT = '[Unsupported Tool Result]'

describe('AI SDK LLMObs utilities', () => {
  describe('getToolCallResultContent', () => {
    it('formats text output variants', () => {
      assert.strictEqual(getToolCallResultContent({ output: { type: 'text', value: 'result' } }), 'result')
      assert.strictEqual(getToolCallResultContent({ output: { type: 'error-text', value: 'failure' } }), 'failure')
    })

    it('formats JSON output variants', () => {
      const value = { answer: 42 }

      assert.strictEqual(
        getToolCallResultContent({ output: { type: 'json', value } }),
        JSON.stringify(value)
      )
      assert.strictEqual(
        getToolCallResultContent({ output: { type: 'error-json', value } }),
        JSON.stringify(value)
      )
    })

    it('formats all legacy result values', () => {
      assert.strictEqual(getToolCallResultContent({ result: '' }), '')
      assert.strictEqual(getToolCallResultContent({ result: 'result' }), 'result')
      assert.strictEqual(getToolCallResultContent({ result: 0 }), '0')
      assert.strictEqual(getToolCallResultContent({ result: false }), 'false')
      assert.strictEqual(getToolCallResultContent({ result: null }), 'null')
      assert.strictEqual(getToolCallResultContent({ result: { answer: 42 } }), '{"answer":42}')
    })

    it('distinguishes absent legacy results', () => {
      assert.strictEqual(getToolCallResultContent({}), UNSUPPORTED_TOOL_RESULT)
      assert.strictEqual(getToolCallResultContent({ result: undefined }), UNSUPPORTED_TOOL_RESULT)
    })

    it('concatenates text and summarizes rich content without serializing payloads', () => {
      const content = [
        { type: 'text', text: 'before' },
        { type: 'media', mediaType: 'image/png', data: 'legacy-image-data' },
        { type: 'media', mediaType: 'application/pdf', data: 'legacy-file-data' },
        { type: 'file-data', mediaType: 'application/pdf', data: 'file-data' },
        { type: 'file-url', url: 'https://example.com/private-file' },
        { type: 'file-id', fileId: 'private-file-id' },
        { type: 'image-data', mediaType: 'image/png', data: 'image-data' },
        { type: 'image-url', url: 'https://example.com/private-image' },
        { type: 'image-file-id', fileId: 'private-image-id' },
        { type: 'custom', providerOptions: { secret: 'provider-data' } },
        { type: 'text', text: 'after' },
      ]

      assert.strictEqual(
        getToolCallResultContent({ output: { type: 'content', value: content } }),
        'before[Image][File][File][File][File][Image][Image][Image][Custom Content]after'
      )
    })

    it('formats empty multipart content', () => {
      assert.strictEqual(getToolCallResultContent({ output: { type: 'content', value: [] } }), '')
    })

    it('formats denied executions', () => {
      assert.strictEqual(
        getToolCallResultContent({ output: { type: 'execution-denied', reason: 'Approval rejected' } }),
        'Approval rejected'
      )
      assert.strictEqual(
        getToolCallResultContent({ output: { type: 'execution-denied' } }),
        '[Tool Execution Denied]'
      )
      assert.strictEqual(
        getToolCallResultContent({ output: { type: 'execution-denied', reason: '' } }),
        ''
      )
    })

    it('rejects malformed output variants', () => {
      const malformedOutputs = [
        null,
        'text',
        { type: 'text' },
        { type: 'text', value: 42 },
        { type: 'error-text', value: {} },
        { type: 'json', value: undefined },
        { type: 'json', value: Symbol('result') },
        { type: 'error-json', value: () => {} },
        { type: 'content', value: {} },
        { type: 'execution-denied', reason: {} },
        { type: 'unknown', value: 'result' },
      ]

      for (const output of malformedOutputs) {
        assert.strictEqual(getToolCallResultContent({ output }), UNPARSABLE_TOOL_RESULT)
      }
    })

    it('rejects malformed multipart content', () => {
      const sparseContent = new Array(1)
      const malformedValues = [
        [null],
        ['text'],
        [{ type: 'text' }],
        [{ type: 'text', text: 42 }],
        [{ type: 'media' }],
        [{ type: 'unknown' }],
        [{ type: Symbol('text'), text: 'result' }],
        [{ type: 'text', text: 'before' }, { type: 'unknown' }],
        sparseContent,
      ]

      for (const value of malformedValues) {
        assert.strictEqual(
          getToolCallResultContent({ output: { type: 'content', value } }),
          UNPARSABLE_TOOL_RESULT
        )
      }
    })

    it('does not throw for circular values', () => {
      const circular = {}
      circular.self = circular

      assert.strictEqual(
        getToolCallResultContent({ output: { type: 'json', value: circular } }),
        UNPARSABLE_TOOL_RESULT
      )
      assert.strictEqual(
        getToolCallResultContent({ output: { type: 'error-json', value: circular } }),
        UNPARSABLE_TOOL_RESULT
      )
      assert.strictEqual(getToolCallResultContent({ result: circular }), UNPARSABLE_TOOL_RESULT)
      assert.strictEqual(getToolCallResultContent({ result: 1n }), UNPARSABLE_TOOL_RESULT)
    })

    it('does not throw for throwing external objects', () => {
      const throwingContent = new Proxy({}, {
        get () {
          throw new Error('unexpected content access')
        },
      })
      const throwingOutput = new Proxy({}, {
        get () {
          throw new Error('unexpected output access')
        },
      })
      const throwingParts = new Proxy([], {
        get () {
          throw new Error('unexpected content part access')
        },
      })

      assert.strictEqual(getToolCallResultContent(throwingContent), UNPARSABLE_TOOL_RESULT)
      assert.strictEqual(getToolCallResultContent({ output: throwingOutput }), UNPARSABLE_TOOL_RESULT)
      assert.strictEqual(
        getToolCallResultContent({ output: { type: 'content', value: throwingParts } }),
        UNPARSABLE_TOOL_RESULT
      )
    })

    it('rejects malformed content containers', () => {
      assert.strictEqual(getToolCallResultContent(), UNPARSABLE_TOOL_RESULT)
      assert.strictEqual(getToolCallResultContent(null), UNPARSABLE_TOOL_RESULT)
      assert.strictEqual(getToolCallResultContent('result'), UNPARSABLE_TOOL_RESULT)
    })
  })
})
