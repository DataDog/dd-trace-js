'use strict'

const assert = require('node:assert/strict')
const path = require('path')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const { sandboxCwd, useSandbox, FakeAgent, spawnProc, stopProc } = require('../helpers')
const { assertObjectContains } = require('../helpers')
const startApiMock = require('./api-mock')
const startOpenAIMock = require('./openai-mock')
const { executeRequest } = require('./util')

function assertHasGuardSpan (payload, predicate) {
  const spans = payload[0].filter(span => span.name === 'ai_guard')
  assert.ok(spans.length > 0)
  const matching = spans.find(predicate)
  assert.notStrictEqual(matching, undefined)
}

describe('AIGuard SDK integration tests', () => {
  let cwd, appFile, agent, proc, api, openaiApi, url

  useSandbox(['express', 'ai@6.0.39', 'openai@6'])

  before(async function () {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'aiguard/server.js')
    api = await startApiMock()
    openaiApi = await startOpenAIMock()
  })

  after(async () => {
    await api.close()
    await openaiApi.close()
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
    proc = await spawnProc(appFile, {
      cwd,
      env: {
        DD_SERVICE: 'ai_guard_integration_test',
        DD_ENV: 'test',
        DD_TRACE_ENABLED: 'true',
        DD_TRACE_CLIENT_IP_ENABLED: 'false',
        DD_TRACE_AGENT_PORT: String(agent.port),
        DD_AI_GUARD_ENABLED: 'true',
        DD_AI_GUARD_BLOCK: 'true',
        DD_AI_GUARD_ENDPOINT: `http://localhost:${api.address().port}`,
        DD_API_KEY: 'DD_API_KEY',
        DD_APP_KEY: 'DD_APP_KEY',
        OPENAI_BASE_URL: `http://127.0.0.1:${openaiApi.address().port}/v1`,
      },
    })
    url = `${proc.url}`
  })

  afterEach(async () => {
    await stopProc(proc)
    await agent.stop()
  })

  it('test default options honors remote blocking', async () => {
    const response = await executeRequest(`${url}/deny-default-options`, 'GET')
    assert.strictEqual(response.status, 403)
    assertObjectContains(response.body, 'I am feeling suspicious today')

    await agent.assertMessageReceived(({ payload }) => {
      const span = payload[0].find(span => span.name === 'ai_guard')
      assert.notStrictEqual(span, undefined)
      assert.strictEqual(span.meta['ai_guard.action'], 'DENY')
      assert.strictEqual(span.meta['ai_guard.blocked'], 'true')
    })
  })

  it('adds client ip tags to the request root span when AI Guard runs', async () => {
    const response = await executeRequest(`${url}/allow`, 'GET', {
      'x-forwarded-for': '203.0.113.10, 10.0.0.1',
    })

    assert.strictEqual(response.status, 200)

    await agent.assertMessageReceived(({ payload }) => {
      const requestSpan = payload[0].find(span => span.name === 'express.request')
      const guardSpan = payload[0].find(span => span.name === 'ai_guard')

      assert.notStrictEqual(requestSpan, undefined)
      assert.notStrictEqual(guardSpan, undefined)
      assert.strictEqual(requestSpan.meta['http.client_ip'], '203.0.113.10')
      assert.ok(requestSpan.meta['network.client.ip'])
    })
  })

  it('does not add client ip tags when no AI Guard span is created', async () => {
    const response = await executeRequest(`${url}/no-aiguard`, 'GET', {
      'x-forwarded-for': '203.0.113.10, 10.0.0.1',
    })

    assert.strictEqual(response.status, 200)
    assert.deepStrictEqual(response.body, { ok: true })

    await agent.assertMessageReceived(({ payload }) => {
      const requestSpan = payload[0].find(span => span.name === 'express.request')
      const guardSpan = payload[0].find(span => span.name === 'ai_guard')

      assert.notStrictEqual(requestSpan, undefined)
      assert.strictEqual(guardSpan, undefined)
      assert.strictEqual(requestSpan.meta['http.client_ip'], undefined)
      assert.strictEqual(requestSpan.meta['network.client.ip'], undefined)
    })
  })

  const directApiSuite = [
    { endpoint: '/allow', action: 'ALLOW', reason: 'The prompt looks harmless' },
    { endpoint: '/deny', action: 'DENY', reason: 'I am feeling suspicious today' },
    { endpoint: '/abort', action: 'ABORT', reason: 'The user is trying to destroy me' },
  ].flatMap(r => [
    { ...r, blocking: true },
    { ...r, blocking: false },
  ])

  for (const { endpoint, action, reason, blocking } of directApiSuite) {
    it(`test evaluate with ${action} response (blocking: ${blocking})`, async () => {
      const headers = blocking ? { 'x-blocking-enabled': 'true' } : null
      const response = await executeRequest(`${url}${endpoint}`, 'GET', headers)

      if (blocking && action !== 'ALLOW') {
        assert.strictEqual(response.status, 403)
        assertObjectContains(response.body, reason)
      } else {
        assert.strictEqual(response.status, 200)
        assert.strictEqual(response.body?.action, action)
        assert.strictEqual(response.body?.reason, reason)
      }

      await agent.assertMessageReceived(({ payload }) => {
        const span = payload[0].find(span => span.name === 'ai_guard')
        assert.notStrictEqual(span, undefined)
        assert.strictEqual(span.meta['ai_guard.action'], action)
      })
    })
  }

  const autoSuite = [
    {
      mode: 'point1',
      target: 'prompt',
      description: 'blocks malicious user input before LLM call',
    },
    {
      mode: 'point2',
      target: 'prompt',
      description: 'blocks assistant text response with sensitive data',
    },
    {
      mode: 'point3',
      target: 'tool',
      description: 'blocks dangerous tool calls before execution',
    },
    {
      mode: 'point4',
      target: 'tool',
      description: 'blocks malicious tool output before LLM sees it',
    },
  ]

  for (const { mode, target, description } of autoSuite) {
    it(`allows safe messages (${description})`, async () => {
      const response = await executeRequest(`${url}/auto?mode=${mode}&deny=false`)
      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual(response.body, { blocked: false })

      await agent.assertMessageReceived(({ payload }) => {
        assertHasGuardSpan(payload, span =>
          span.meta['ai_guard.target'] === target &&
          span.meta['ai_guard.action'] === 'ALLOW'
        )
      })
    })

    it(`blocks dangerous messages (${description})`, async () => {
      const response = await executeRequest(`${url}/auto?mode=${mode}&deny=true`)
      assert.strictEqual(response.status, 403)
      assert.deepStrictEqual(JSON.parse(response.body), { blocked: true, reason: 'Blocked by policy' })

      await agent.assertMessageReceived(({ payload }) => {
        assertHasGuardSpan(payload, span =>
          span.meta['ai_guard.target'] === target &&
          span.meta['ai_guard.action'] === 'DENY' &&
          span.meta['ai_guard.blocked'] === 'true'
        )
      })
    })
  }

  const openaiSuite = [
    { endpoint: '/openai-chat', name: 'chat.completions.create' },
    { endpoint: '/openai-responses', name: 'responses.create' },
  ]

  for (const { endpoint, name } of openaiSuite) {
    it(`allows safe OpenAI ${name} requests`, async () => {
      const response = await executeRequest(`${url}${endpoint}?deny=false`)
      assert.strictEqual(response.status, 200)
      assert.strictEqual(response.body.blocked, false)

      await agent.assertMessageReceived(({ payload }) => {
        const guardSpans = payload[0].filter(span => span.name === 'ai_guard')
        // One span for Before Model, one for After Model.
        assert.strictEqual(guardSpans.length, 2)
        for (const span of guardSpans) {
          assert.strictEqual(span.meta['ai_guard.action'], 'ALLOW')
        }
      })
    })

    it(`blocks dangerous OpenAI ${name} requests at Before Model`, async () => {
      const response = await executeRequest(`${url}${endpoint}?deny=true`)
      assert.strictEqual(response.status, 403)
      assert.deepStrictEqual(JSON.parse(response.body), { blocked: true, reason: 'Blocked by policy' })

      await agent.assertMessageReceived(({ payload }) => {
        assertHasGuardSpan(payload, span =>
          span.meta['ai_guard.action'] === 'DENY' &&
          span.meta['ai_guard.blocked'] === 'true'
        )
      })
    })
  }

  const openaiAfterModelSuite = [
    { endpoint: '/openai-chat-after-deny', name: 'chat.completions.create' },
    { endpoint: '/openai-responses-after-deny', name: 'responses.create' },
  ]

  for (const { endpoint, name } of openaiAfterModelSuite) {
    it(`blocks dangerous OpenAI ${name} responses at After Model`, async () => {
      const response = await executeRequest(`${url}${endpoint}`)
      assert.strictEqual(response.status, 403)
      assert.deepStrictEqual(JSON.parse(response.body), { blocked: true, reason: 'Blocked by policy' })

      await agent.assertMessageReceived(({ payload }) => {
        assertHasGuardSpan(payload, span =>
          span.meta['ai_guard.action'] === 'DENY' &&
          span.meta['ai_guard.blocked'] === 'true'
        )
      })
    })
  }

  it('evaluates tool_calls in the After Model span for chat.completions', async () => {
    const response = await executeRequest(`${url}/openai-chat-tool?deny=false`)
    assert.strictEqual(response.status, 200)
    assert.strictEqual(response.body.blocked, false)
    assert.ok(Array.isArray(response.body.message.tool_calls))

    await agent.assertMessageReceived(({ payload }) => {
      const guardSpans = payload[0].filter(span => span.name === 'ai_guard')
      assert.strictEqual(guardSpans.length, 2)
      for (const span of guardSpans) {
        assert.strictEqual(span.meta['ai_guard.action'], 'ALLOW')
      }
    })
  })

  it('handles multimodal user content (text + image) without breaking the call', async () => {
    const response = await executeRequest(`${url}/openai-chat-multimodal?deny=false`)
    assert.strictEqual(response.status, 200)
    assert.strictEqual(response.body.blocked, false)

    await agent.assertMessageReceived(({ payload }) => {
      const guardSpans = payload[0].filter(span => span.name === 'ai_guard')
      assert.strictEqual(guardSpans.length, 2)
      for (const span of guardSpans) {
        assert.strictEqual(span.meta['ai_guard.action'], 'ALLOW')
      }
    })
  })

  it('blocks a multimodal user prompt when AI Guard denies the text part', async () => {
    const response = await executeRequest(`${url}/openai-chat-multimodal?deny=true`)
    assert.strictEqual(response.status, 403)
    assert.deepStrictEqual(JSON.parse(response.body), { blocked: true, reason: 'Blocked by policy' })

    await agent.assertMessageReceived(({ payload }) => {
      assertHasGuardSpan(payload, span =>
        span.meta['ai_guard.action'] === 'DENY' &&
        span.meta['ai_guard.blocked'] === 'true'
      )
    })
  })

  it('passes a full multi-turn (system + user + assistant + tool) conversation through', async () => {
    const response = await executeRequest(`${url}/openai-chat-multiturn?deny=false`)
    assert.strictEqual(response.status, 200)
    assert.strictEqual(response.body.blocked, false)

    await agent.assertMessageReceived(({ payload }) => {
      const guardSpans = payload[0].filter(span => span.name === 'ai_guard')
      assert.strictEqual(guardSpans.length, 2)
    })
  })

  it('handles responses.create with a multi-item input (function_call_output + message)', async () => {
    const response = await executeRequest(`${url}/openai-responses-array-input?deny=false`)
    assert.strictEqual(response.status, 200)
    assert.strictEqual(response.body.blocked, false)
  })

  it('does not double-evaluate when the caller uses .withResponse()', async () => {
    const response = await executeRequest(`${url}/openai-with-response`)
    assert.strictEqual(response.status, 200)
    assert.strictEqual(response.body.blocked, false)
    assert.strictEqual(response.body.hasRawResponse, true)

    await agent.assertMessageReceived(({ payload }) => {
      const guardSpans = payload[0].filter(span => span.name === 'ai_guard')
      // Lazy memoization must coalesce the inputEval; we expect exactly Before+After
      // even though .withResponse() may invoke .parse() multiple times internally.
      assert.strictEqual(guardSpans.length, 2)
    })
  })

  it('returns the raw Response from .asResponse() after Before-Model resolves', async () => {
    // Asserting only the user-visible outcome: AI Guard does not break the call when
    // the caller consumes the raw HTTP response. Trace-level assertions are intentionally
    // skipped here because the openai instrumentation does not publish `asyncEnd` for
    // the asResponse-only path (pre-existing behavior, see openai.js handleUnwrappedAPIPromise),
    // so the openai span never finalizes and the trace is not flushed during this test
    // window. The companion deny test below covers the Before-Model rejection path.
    const response = await executeRequest(`${url}/openai-as-response?deny=false`)
    assert.strictEqual(response.status, 200)
    assert.strictEqual(response.body.status, 200)
  })

  it('rejects .asResponse() with AIGuardAbortError when Before-Model denies', async () => {
    const response = await executeRequest(`${url}/openai-as-response?deny=true`)
    assert.strictEqual(response.status, 403)
    assert.deepStrictEqual(JSON.parse(response.body), { blocked: true, reason: 'Blocked by policy' })
  })

  it('does not break the OpenAI call when the AI Guard service is unhealthy (503)', async () => {
    // The load-bearing never-break-clients gate.
    const response = await executeRequest(`${url}/openai-aiguard-down`)
    assert.strictEqual(response.status, 200)
    assert.strictEqual(response.body.blocked, false)
    assert.ok(response.body.message)
  })

  it('skips AI Guard for streaming chat.completions and consumes the stream cleanly', async () => {
    const response = await executeRequest(`${url}/openai-stream`)
    assert.strictEqual(response.status, 200)
    assert.strictEqual(response.body.streamed, true)
    assert.ok(response.body.chunks > 0)

    await agent.assertMessageReceived(({ payload }) => {
      const guardSpans = payload[0].filter(span => span.name === 'ai_guard')
      assert.strictEqual(guardSpans.length, 0, 'streaming requests must not produce AI Guard spans')
    })
  })
})
