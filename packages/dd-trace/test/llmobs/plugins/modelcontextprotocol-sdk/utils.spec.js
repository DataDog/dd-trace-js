'use strict'

const assert = require('node:assert/strict')

const {
  formatOutput,
  formatServerRequestInput,
  formatServerRequestOutput,
  formatToolInput,
  getInitializeClientInfo,
  getRequestToolName,
  getServerRequestSessionId,
} = require('../../../../src/llmobs/plugins/modelcontextprotocol-sdk/utils')

describe('modelcontextprotocol-sdk LLMObs utils', () => {
  it('formats tool input safely', () => {
    const circular = {}
    circular.self = circular

    assert.strictEqual(formatToolInput({ query: 'hello' }), JSON.stringify({ query: 'hello' }))
    assert.strictEqual(formatToolInput(), JSON.stringify({}))
    assert.strictEqual(formatToolInput(circular), '')
  })

  it('formats text content output safely', () => {
    assert.strictEqual(formatOutput({
      content: [
        null,
        'not-an-object',
        { type: 'image', data: 'ignored' },
        { type: 'text', text: 'hello', annotations: { audience: 'test' }, _meta: { source: 'unit' } },
      ],
      isError: true,
    }), JSON.stringify({
      content: [{
        type: 'text',
        text: 'hello',
        annotations: { audience: 'test' },
        meta: { source: 'unit' },
      }],
      isError: true,
    }))

    const circular = {}
    circular.self = circular

    assert.strictEqual(formatOutput({
      content: [{ type: 'text', text: 'hello', annotations: circular }],
    }), '')
  })

  it('formats server request input without trace metadata', () => {
    assert.strictEqual(formatServerRequestInput(), null)
    assert.strictEqual(formatServerRequestInput({
      method: 'tools/call',
      params: {
        name: 'test-tool',
        arguments: { query: 'hello' },
        _meta: {
          _dd_trace_context: { traceparent: '00-123-456-01' },
          user: 'visible',
        },
      },
    }), JSON.stringify({
      method: 'tools/call',
      params: {
        name: 'test-tool',
        arguments: { query: 'hello' },
        _meta: { user: 'visible' },
      },
    }))

    assert.strictEqual(formatServerRequestInput({
      method: 'tools/list',
      params: {
        _meta: {
          _dd_trace_context: { traceparent: '00-123-456-01' },
        },
      },
    }), JSON.stringify({ method: 'tools/list' }))
  })

  it('formats server request output safely', () => {
    const circular = {}
    circular.self = circular

    assert.strictEqual(formatServerRequestOutput({ ok: true }), JSON.stringify({ ok: true }))
    assert.strictEqual(formatServerRequestOutput(circular), '')
  })

  it('extracts typed initialize client info', () => {
    assert.deepStrictEqual(getInitializeClientInfo(), {})
    assert.deepStrictEqual(getInitializeClientInfo({ params: { clientInfo: 'bad' } }), {})
    assert.deepStrictEqual(getInitializeClientInfo({
      params: {
        clientInfo: {
          name: 'client',
          version: '1.2.3',
          title: 'ignored',
        },
      },
    }), { name: 'client', version: '1.2.3' })
    assert.deepStrictEqual(getInitializeClientInfo({
      params: {
        clientInfo: {
          name: 1,
          version: false,
        },
      },
    }), { name: undefined, version: undefined })
  })

  it('uses only non-empty string tool names', () => {
    assert.strictEqual(getRequestToolName({ name: 'test-tool' }), 'test-tool')
    assert.strictEqual(getRequestToolName({ name: '' }), 'unknown_tool')
    assert.strictEqual(getRequestToolName({ name: 1 }), 'unknown_tool')
    assert.strictEqual(getRequestToolName({ name: {} }), 'unknown_tool')
    assert.strictEqual(getRequestToolName(), 'unknown_tool')
  })

  it('extracts transport session id safely', () => {
    assert.strictEqual(getServerRequestSessionId({ sessionId: 'session-123' }), 'session-123')
    assert.strictEqual(getServerRequestSessionId({
      requestInfo: {
        headers: {
          'mcp-session-id': 'session-456',
        },
      },
    }), 'session-456')
    assert.strictEqual(getServerRequestSessionId({
      requestInfo: {
        headers: {
          'Mcp-Session-Id': ['session-789'],
        },
      },
    }), 'session-789')
    assert.strictEqual(getServerRequestSessionId({ sessionId: '' }), undefined)
    assert.strictEqual(getServerRequestSessionId({
      requestInfo: {
        headers: {
          'mcp-session-id': [''],
        },
      },
    }), undefined)
    assert.strictEqual(getServerRequestSessionId({
      requestInfo: {
        headers: {
          'mcp-session-id': 1,
        },
      },
    }), undefined)
    assert.strictEqual(getServerRequestSessionId(), undefined)
  })
})
