'use strict'

const assert = require('node:assert/strict')
const { rejects } = require('node:assert/strict')

const msgpack = require('@msgpack/msgpack')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const NoopAIGuard = require('../../src/aiguard/noop')
const AIGuard = require('../../src/aiguard/sdk')
const agent = require('../plugins/agent')
const { assertObjectContains } = require('../../../../integration-tests/helpers')

const tracerVersion = require('../../../../package.json').version
const telemetryMetrics = require('../../src/telemetry/metrics')
const appsecNamespace = telemetryMetrics.manager.namespace('appsec')
const { USER_KEEP } = require('../../../../ext/priority')
const { SAMPLING_MECHANISM_AI_GUARD, DECISION_MAKER_KEY } = require('../../src/constants')

describe('AIGuard SDK', () => {
  const config = {
    flushInterval: 0,
    service: 'ai_guard_demo',
    env: 'test',
    apiKey: 'API_KEY',
    appKey: 'APP_KEY',
    protocolVersion: '0.4',
    experimental: {
      aiguard: {
        enabled: true,
        endpoint: 'https://aiguard.com',
        maxMessagesLength: 16,
        maxContentSize: 512 * 1024,
        timeout: 10_000,
      },
    },
  }
  let tracer
  let aiguard
  let count, inc

  const toolCall = [
    { role: 'system', content: 'You are a beautiful AI assistant' },
    { role: 'user', content: 'What is 2 + 2' },
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_1',
          function: {
            name: 'calc',
            arguments: '{ "operator": "+", "args": [2, 2] }',
          },
        },
      ],
    },
  ]

  const toolOutput = [
    ...toolCall,
    { role: 'tool', tool_call_id: 'call_1', content: '5' },
  ]

  const prompt = [
    ...toolOutput,
    { role: 'assistant', content: '2 + 2 is 5' },
    { role: 'user', content: 'Are you sure?' },
  ]

  let originalFetch

  beforeEach(() => {
    tracer = require('../../../dd-trace')
    tracer.init(config)

    originalFetch = global.fetch
    global.fetch = sinon.stub()

    inc = sinon.spy()
    count = sinon.stub(appsecNamespace, 'count').returns({
      inc,
    })
    appsecNamespace.metrics.clear()

    aiguard = new AIGuard(tracer, config)

    return agent.load(null, [])
  })

  afterEach(() => {
    global.fetch = originalFetch
    sinon.restore()
    agent.close()
  })

  const mockFetch = (options) => {
    if (options.error) {
      global.fetch.rejects(options.error)
    } else {
      global.fetch.resolves({
        status: options.status ?? 200,
        json: sinon.stub().resolves(options.body),
      })
    }
  }

  const assertFetch = (messages, url) => {
    const postData = JSON.stringify(
      { data: { attributes: { messages, meta: { service: config.service, env: config.env } } } }
    )
    sinon.assert.calledOnceWithExactly(global.fetch,
      url ?? `${config.experimental.aiguard.endpoint}/evaluate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'DD-API-KEY': config.apiKey,
          'DD-APPLICATION-KEY': config.appKey,
          'DD-AI-GUARD-VERSION': tracerVersion,
          'DD-AI-GUARD-SOURCE': 'SDK',
          'DD-AI-GUARD-LANGUAGE': 'nodejs',
        },
        body: postData,
        signal: sinon.match.instanceOf(AbortSignal),
      }
    )
  }

  const assertAIGuardSpan = async (meta, metaStruct = null) => {
    await agent.assertFirstTraceSpan(span => {
      assert.strictEqual(span.name, 'ai_guard')
      assert.strictEqual(span.resource, 'ai_guard')
      assertObjectContains(span.meta, meta)
      if (metaStruct) {
        assert.deepStrictEqual(msgpack.decode(span.meta_struct.ai_guard), metaStruct)
      }
    }, { rejectFirst: true })
  }

  const assertTelemetry = (metric, tags) => {
    sinon.assert.calledWith(count, metric, tags)
  }

  const testSuite = [
    { action: 'ALLOW', reason: 'Go ahead', tags: [] },
    { action: 'DENY', reason: 'Nope', tags: ['deny_everything', 'test_deny'] },
    { action: 'ABORT', reason: 'Kill it with fire', tags: ['alarm_tag', 'abort_everything'] },
  ].flatMap(r => [
    { ...r, blocking: true },
    { ...r, blocking: false },
  ]).flatMap(r => [
    { ...r, suite: 'tool call', target: 'tool', messages: toolCall },
    { ...r, suite: 'tool output', target: 'tool', messages: toolOutput },
    { ...r, suite: 'prompt', target: 'prompt', messages: prompt },
  ])

  for (const { action, reason, tags, blocking, suite, target, messages } of testSuite) {
    it(`test evaluate '${suite}' with ${action} action (blocking: ${blocking})`, async () => {
      mockFetch({ body: { data: { attributes: { action, reason, tags, is_blocking_enabled: blocking } } } })
      const shouldBlock = action !== 'ALLOW' && blocking

      if (shouldBlock) {
        await rejects(
          () => aiguard.evaluate(messages, { block: true }),
          err => err.name === 'AIGuardAbortError' && err.reason === reason && err.tags === tags &&
            JSON.stringify(err.sds) === '[]'
        )
      } else {
        const evaluation = await aiguard.evaluate(messages, { block: true })
        assert.strictEqual(evaluation.action, action)
        assert.strictEqual(evaluation.reason, reason)
        if (tags) {
          assert.strictEqual(evaluation.tags, tags)
        }
        assert.deepStrictEqual(evaluation.sds, [])
      }

      assertTelemetry('ai_guard.requests', { error: false, action, block: shouldBlock })
      assertFetch(messages)
      await assertAIGuardSpan({
        'ai_guard.target': target,
        'ai_guard.action': action,
        'ai_guard.reason': reason,
        ...(target === 'tool' ? { 'ai_guard.tool_name': 'calc' } : {}),
        ...(shouldBlock ? { 'ai_guard.blocked': 'true', 'error.type': 'AIGuardAbortError' } : {}),
      },
      {
        messages,
        ...(tags.length > 0 ? { attack_categories: tags } : {}),
      })
    })
  }

  it('test evaluate with sds_findings', async () => {
    const sdsFindings = [
      {
        rule_display_name: 'Email Address',
        rule_tag: 'email_address',
        category: 'pii',
        matched_text: 'john.smith@acmebank.com',
        location: { start_index: 35, end_index_exclusive: 58, path: 'messages[0].content' },
      },
      {
        rule_display_name: 'Social Security Number',
        rule_tag: 'social_security_number',
        category: 'pii',
        matched_text: '456-78-9012',
        location: { start_index: 73, end_index_exclusive: 84, path: 'messages[0].content' },
      },
    ]
    const messages = [{ role: 'user', content: 'My SSN is 456-78-9012 and email john.smith@acmebank.com' }]
    mockFetch({
      body: {
        data: {
          attributes: {
            action: 'ALLOW',
            reason: 'No rule match.',
            tags: [],
            sds_findings: sdsFindings,
            is_blocking_enabled: true,
          },
        },
      },
    })

    const result = await aiguard.evaluate(messages)

    assert.deepStrictEqual(result.sds, sdsFindings)
    await assertAIGuardSpan(
      { 'ai_guard.target': 'prompt', 'ai_guard.action': 'ALLOW' },
      { messages, sds: sdsFindings }
    )
  })

  it('test evaluate with empty sds_findings', async () => {
    const messages = [{ role: 'user', content: 'Hello' }]
    mockFetch({
      body: {
        data: {
          attributes: { action: 'ALLOW', reason: 'OK', tags: [], sds_findings: [], is_blocking_enabled: false },
        },
      },
    })

    const result = await aiguard.evaluate(messages)

    assert.deepStrictEqual(result.sds, [])
    await assertAIGuardSpan(
      { 'ai_guard.target': 'prompt', 'ai_guard.action': 'ALLOW' },
      { messages }
    )
  })

  it('test evaluate with sds_findings in abort error', async () => {
    const sdsFindings = [
      {
        rule_display_name: 'Credit Card Number',
        rule_tag: 'credit_card',
        category: 'pii',
        matched_text: '4111111111111111',
        location: { start_index: 10, end_index_exclusive: 26, path: 'messages[0].content[0].text' },
      },
    ]
    const messages = [{ role: 'user', content: 'My card is 4111111111111111' }]
    mockFetch({
      body: {
        data: {
          attributes: {
            action: 'ABORT',
            reason: 'PII detected',
            tags: ['pii'],
            sds_findings: sdsFindings,
            is_blocking_enabled: true,
          },
        },
      },
    })

    await rejects(
      () => aiguard.evaluate(messages, { block: true }),
      err => err.name === 'AIGuardAbortError' && JSON.stringify(err.sds) === JSON.stringify(sdsFindings)
    )
  })

  it('test evaluate with API error', async () => {
    const errors = [{ status: 400, title: 'Internal server error' }]
    mockFetch({
      status: 400,
      body: { errors },
    })

    await rejects(
      () => aiguard.evaluate(toolCall),
      err =>
        err.name === 'AIGuardClientError' && JSON.stringify(err.errors) === JSON.stringify(errors)
    )

    assertTelemetry('ai_guard.requests', { error: true })
    assertFetch(toolCall)
    await assertAIGuardSpan({
      'ai_guard.target': 'tool',
      'error.type': 'AIGuardClientError',
    })
  })

  it('test evaluate with API exception', async () => {
    mockFetch({
      error: new Error('Boom!!!'),
    })

    await rejects(
      () => aiguard.evaluate(toolCall),
      err =>
        err.name === 'AIGuardClientError' && err.message === 'Unexpected error calling AI Guard service: Boom!!!',
    )

    assertTelemetry('ai_guard.requests', { error: true })
    assertFetch(toolCall)
    await assertAIGuardSpan({
      'ai_guard.target': 'tool',
      'error.type': 'AIGuardClientError',
    })
  })

  it('test evaluate with invalid JSON', async () => {
    mockFetch({ body: { message: 'This is an invalid JSON' } })

    await rejects(
      () => aiguard.evaluate(toolCall),
      err => err.name === 'AIGuardClientError'
    )

    assertTelemetry('ai_guard.requests', { error: true })
    assertFetch(toolCall)
    await assertAIGuardSpan({
      'ai_guard.target': 'tool',
      'error.type': 'AIGuardClientError',
    })
  })

  it('test evaluate with with missing action or response', async () => {
    mockFetch({ body: { data: { attributes: { reason: 'I miss something' } } } })

    await rejects(
      () => aiguard.evaluate(toolCall),
      err => err.name === 'AIGuardClientError'
    )

    assertTelemetry('ai_guard.requests', { error: true })
    assertFetch(toolCall)
    await assertAIGuardSpan({
      'ai_guard.target': 'tool',
      'error.type': 'AIGuardClientError',
    })
  })

  it('test noop implementation', async () => {
    const noop = new NoopAIGuard()
    const result = await noop.evaluate(prompt)
    result.action === 'ALLOW'
    result.reason === 'AI Guard is not enabled'
  })

  it('test message length truncation', async () => {
    const maxMessages = config.experimental.aiguard.maxMessagesLength
    const messages = Array.from({ length: maxMessages + 1 }, (_, i) => ({
      role: 'user',
      content: `This is a prompt: ${i}`,
    }))
    mockFetch({
      body: { data: { attributes: { action: 'ALLOW', reason: 'OK', is_blocking_enabled: false } } },
    })

    await aiguard.evaluate(messages)

    assertTelemetry('ai_guard.truncated', { type: 'messages' })
    assertFetch(messages)
    await assertAIGuardSpan(
      { 'ai_guard.target': 'prompt', 'ai_guard.action': 'ALLOW' },
      { messages: messages.slice(-maxMessages) }
    )
  })

  it('test message content truncation', async () => {
    const maxContent = config.experimental.aiguard.maxContentSize
    const content = Array(maxContent + 1).fill('A').join('')
    const messages = [{ role: 'user', content }]
    mockFetch({
      body: { data: { attributes: { action: 'ALLOW', reason: 'OK', is_blocking_enabled: false } } },
    })

    await aiguard.evaluate(messages)

    assertTelemetry('ai_guard.truncated', { type: 'content' })
    assertFetch(messages)
    await assertAIGuardSpan(
      { 'ai_guard.target': 'prompt', 'ai_guard.action': 'ALLOW' },
      { messages: [{ role: 'user', content: content.slice(0, maxContent) }] }
    )
  })

  it('test message immutability', async () => {
    const messages = [{
      role: 'assistant',
      tool_calls: [{ id: 'call_1', function: { name: 'shell', arguments: '{"cmd": "ls -lah"}' } }],
    }]
    mockFetch({
      body: { data: { attributes: { action: 'ALLOW', reason: 'OK', is_blocking_enabled: false } } },
    })

    await tracer.trace('test', async () => {
      await aiguard.evaluate(messages)
      // update messages before flushing
      messages[0].tool_calls.push({ id: 'call_2', function: { name: 'shell', arguments: '{"cmd": "rm -rf"}' } })
      messages.push({ role: 'tool', tool_call_id: 'call_1', content: 'dir1, dir2, dir3' })
    })

    await agent.assertSomeTraces(traces => {
      const span = traces[0][1] // second span in the trace
      const metaStruct = msgpack.decode(span.meta_struct.ai_guard)
      assert.equal(metaStruct.messages.length, 1)
      assert.equal(metaStruct.messages[0].tool_calls.length, 1)
    })
  })

  it('test missing required fields uses noop as default', async () => {
    const client = new AIGuard(tracer, { aiguard: { endpoint: 'http://aiguard' } })
    const result = await client.evaluate(toolCall)
    assert.strictEqual(result.action, 'ALLOW')
    assert.strictEqual(result.reason, 'AI Guard is not enabled')
  })

  const sites = [
    { site: 'datad0g.com', endpoint: 'https://app.datad0g.com/api/v2/ai-guard' },
    { site: 'datadoghq.com', endpoint: 'https://app.datadoghq.com/api/v2/ai-guard' },
  ]
  for (const { site, endpoint } of sites) {
    it(`test endpoint discovery: ${site}`, async () => {
      const newConfig = { site, ...config }
      delete newConfig.experimental.aiguard.endpoint
      const client = new AIGuard(tracer, newConfig)
      mockFetch({
        body: { data: { attributes: { action: 'ALLOW', reason: 'OK', is_blocking_enabled: false } } },
      })

      await client.evaluate(toolCall)

      assertFetch(toolCall, `${endpoint}/evaluate`)
    })
  }

  describe('manual keep on root span', () => {
    const assertRootSpanKept = async () => {
      await agent.assertSomeTraces(traces => {
        const rootSpan = traces[0][0]
        assert.strictEqual(rootSpan.metrics._sampling_priority_v1, USER_KEEP)
        assert.strictEqual(rootSpan.meta[DECISION_MAKER_KEY], `-${SAMPLING_MECHANISM_AI_GUARD}`)
      })
    }

    it('sets USER_KEEP on root span after ALLOW evaluation', async () => {
      mockFetch({
        body: { data: { attributes: { action: 'ALLOW', reason: 'OK', tags: [], is_blocking_enabled: false } } },
      })

      await tracer.trace('root', async () => {
        await aiguard.evaluate(prompt)
      })

      await assertRootSpanKept()
    })

    it('sets USER_KEEP on root span after DENY evaluation (non-blocking)', async () => {
      mockFetch({
        body: {
          data: { attributes: { action: 'DENY', reason: 'denied', tags: ['deny_tag'], is_blocking_enabled: false } },
        },
      })

      await tracer.trace('root', async () => {
        await aiguard.evaluate(prompt, { block: false })
      })

      await assertRootSpanKept()
    })

    it('keeps trace even when auto-sampling would drop it', async () => {
      // Configure sampler to drop all traces (0% sample rate)
      tracer._tracer._prioritySampler.configure('test', { sampleRate: 0 })

      try {
        mockFetch({
          body: { data: { attributes: { action: 'ALLOW', reason: 'OK', tags: [], is_blocking_enabled: false } } },
        })

        await tracer.trace('root', async () => {
          await aiguard.evaluate(prompt)
        })

        await assertRootSpanKept()
      } finally {
        tracer._tracer._prioritySampler.configure('test', {})
      }
    })

    it('sets USER_KEEP on root span after ABORT evaluation (blocking)', async () => {
      mockFetch({
        body: {
          data: { attributes: { action: 'ABORT', reason: 'blocked', tags: ['tag'], is_blocking_enabled: true } },
        },
      })

      await tracer.trace('root', async () => {
        try {
          await aiguard.evaluate(prompt, { block: true })
        } catch {
          // expected AIGuardAbortError
        }
      })

      await assertRootSpanKept()
    })
  })
})
