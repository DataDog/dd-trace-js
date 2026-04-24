'use strict'

const assert = require('node:assert')
const { describe, it } = require('mocha')

const {
  formatIO,
  getContentFromMessage,
  getRole,
} = require('../../../../src/llmobs/plugins/shared/messages')

// Minimal duck-typed stand-ins for `@langchain/core` BaseMessage subclasses
// (HumanMessage / AIMessage / SystemMessage). These exercise the same surface
// formatIO / getContentFromMessage rely on: `content`, `_getType()`, `getType()`.
class HumanMessageStub {
  constructor (content) {
    this.content = content
    this.additional_kwargs = {}
    this.response_metadata = {}
    this.id = 'msg_123'
  }

  _getType () { return 'human' }
}

class AIMessageStub {
  constructor (content) {
    this.content = content
    this.additional_kwargs = {}
    this.response_metadata = {}
    this.tool_calls = []
  }

  getType () { return 'ai' }
}

describe('llmobs shared messages util', () => {
  describe('getRole', () => {
    it('maps an explicit role via ROLE_MAPPINGS', () => {
      assert.strictEqual(getRole({ role: 'human' }), 'user')
      assert.strictEqual(getRole({ role: 'ai' }), 'assistant')
      assert.strictEqual(getRole({ role: 'system' }), 'system')
    })

    it('passes through unknown roles', () => {
      assert.strictEqual(getRole({ role: 'tool' }), 'tool')
    })

    it('falls back to _getType()', () => {
      assert.strictEqual(getRole(new HumanMessageStub('hi')), 'user')
    })

    it('falls back to getType()', () => {
      assert.strictEqual(getRole(new AIMessageStub('hi')), 'assistant')
    })
  })

  describe('getContentFromMessage', () => {
    it('returns strings unchanged', () => {
      assert.strictEqual(getContentFromMessage('hello'), 'hello')
    })

    it('formats a BaseMessage-like object as { content, role }', () => {
      assert.deepStrictEqual(
        getContentFromMessage(new HumanMessageStub('Hello there')),
        { content: 'Hello there', role: 'user' }
      )
      assert.deepStrictEqual(
        getContentFromMessage(new AIMessageStub('Hi!')),
        { content: 'Hi!', role: 'assistant' }
      )
    })

    it('defaults content to empty string when missing', () => {
      const msg = new HumanMessageStub()
      msg.content = undefined
      assert.deepStrictEqual(
        getContentFromMessage(msg),
        { content: '', role: 'user' }
      )
    })
  })

  describe('formatIO', () => {
    it('returns empty string for null / undefined', () => {
      assert.strictEqual(formatIO(null), '')
      assert.strictEqual(formatIO(undefined), '')
    })

    it('returns primitives unchanged', () => {
      assert.strictEqual(formatIO('hello'), 'hello')
      assert.strictEqual(formatIO(42), 42)
      assert.strictEqual(formatIO(true), true)
    })

    it('recurses into plain objects', () => {
      assert.deepStrictEqual(
        formatIO({ a: 'x', b: { c: 'y' } }),
        { a: 'x', b: { c: 'y' } }
      )
    })

    it('recurses into arrays', () => {
      assert.deepStrictEqual(formatIO(['a', 'b']), ['a', 'b'])
    })

    it('renders BaseMessage instances as { content, role } — regression for #8096', () => {
      assert.deepStrictEqual(
        formatIO(new HumanMessageStub('What is OpenTelemetry?')),
        { content: 'What is OpenTelemetry?', role: 'user' }
      )
    })

    it('renders nested BaseMessage arrays (LangGraph Pregel state shape)', () => {
      const state = {
        messages: [
          new HumanMessageStub('What is OpenTelemetry? One sentence.'),
          new AIMessageStub('A vendor-neutral observability framework.'),
        ],
      }

      assert.deepStrictEqual(formatIO(state), {
        messages: [
          { content: 'What is OpenTelemetry? One sentence.', role: 'user' },
          { content: 'A vendor-neutral observability framework.', role: 'assistant' },
        ],
      })
    })
  })
})
