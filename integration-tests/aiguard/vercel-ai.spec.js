'use strict'

const assert = require('node:assert/strict')
const { join } = require('node:path')

const { after, before, beforeEach, describe, it } = require('mocha')

const { sandboxCwd, spawnProc, stopProc, useSandbox } = require('../helpers')
const startApiMock = require('./api-mock')
const { executeRequest } = require('./util')

describe('AI Guard with Vercel AI', () => {
  let api
  let evaluations

  useSandbox(['ai'])

  before(async () => {
    api = await startApiMock(messages => evaluations.push(messages))
  })

  beforeEach(() => { evaluations = [] })
  after(() => new Promise(resolve => api.close(resolve)))

  /**
   * @param {string} path
   * @returns {Promise<object>}
   */
  async function request (path) {
    const cwd = sandboxCwd()
    const proc = await spawnProc(join(cwd, 'aiguard/vercel-ai.mjs'), {
      cwd,
      execArgv: ['--import', 'dd-trace/initialize.mjs'],
      env: {
        ...process.env,
        DD_TRACE_ENABLED: 'true',
        DD_TRACE_AGENT_URL: 'http://127.0.0.1:1',
        DD_TRACE_STARTUP_LOGS: 'false',
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
        DD_REMOTE_CONFIGURATION_ENABLED: 'false',
        DD_AI_GUARD_ENABLED: 'true',
        DD_AI_GUARD_BLOCK: 'true',
        DD_AI_GUARD_ANALYZE_STREAM_RESPONSES_ENABLED: 'true',
        DD_AI_GUARD_DISABLED_INTEGRATIONS: '',
        DD_AI_GUARD_ENDPOINT: `http://localhost:${api.address().port}`,
        DD_API_KEY: 'test',
        DD_APP_KEY: 'test',
      },
    })
    try {
      const { status, body } = await executeRequest(`${proc.url}${path}`)
      assert.strictEqual(status, 200)
      return body
    } finally {
      await stopProc(proc)
    }
  }

  for (const operation of ['generate', 'stream']) {
    it(`evaluates ${operation} input and output once`, async () => {
      assert.deepStrictEqual(await request(`/${operation}`), { text: 'Hello', toolExecutions: 0 })
      assert.strictEqual(evaluations.length, 2)
      assert.deepStrictEqual(evaluations[0], [{ role: 'user', content: 'Hello' }])
      assert.deepStrictEqual(evaluations[1].at(-1), { role: 'assistant', content: 'Hello' })
    })
  }

  for (const operation of ['generate', 'agent']) {
    for (const field of ['text', 'tool']) {
      it(`blocks ${operation} mixed ${field} before tool execution`, async () => {
        assert.deepStrictEqual(await request(`/${operation}?mixed&deny=${field}`), {
          text: '',
          toolExecutions: 0,
          error: { name: 'AIGuardAbortError', message: 'Blocked by policy' },
        })
        assert.strictEqual(evaluations.length, 2)
      })
    }
  }

  it('preserves safe mixed content in tool-loop output and history', async () => {
    assert.deepStrictEqual(await request('/agent?mixed'), { text: 'Looking upHello', toolExecutions: 1 })
    assert.strictEqual(evaluations.length, 4)
    const assistant = {
      role: 'assistant',
      content: 'Looking up',
      tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{"query":"safe"}' } }],
    }
    assert.deepStrictEqual(evaluations[1].at(-1), assistant)
    assert.deepStrictEqual(evaluations[2].find(message => message.role === 'assistant'), assistant)
  })

  for (const image of ['legacy', 'generic']) {
    for (const operation of ['generate', 'agent']) {
      it(`blocks ${operation} unsafe output after a ${image} image-only prompt`, async () => {
        assert.deepStrictEqual(await request(`/${operation}?image=${image}&mixed&deny=text`), {
          text: '',
          toolExecutions: 0,
          error: { name: 'AIGuardAbortError', message: 'Blocked by policy' },
        })
        assert.strictEqual(evaluations.length, 2)
        assert.deepStrictEqual(evaluations[1].at(-1).content, '[deny] unsafe text')
      })
    }
  }

  it('preserves image content in evaluation requests', async () => {
    assert.deepStrictEqual(await request('/generate?image'), { text: 'Hello', toolExecutions: 0 })
    assert.strictEqual(evaluations.length, 2)
    assert.deepStrictEqual(evaluations[0], [{
      role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }],
    }])
  })
})
