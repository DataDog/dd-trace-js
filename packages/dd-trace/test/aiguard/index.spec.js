'use strict'

const msgpack = require('@msgpack/msgpack')
const { rejects } = require('node:assert/strict')
const { expect } = require('chai')
const { describe, it } = require('mocha')
const sinon = require('sinon')
const agent = require('../plugins/agent')
const NoopAIGuard = require('../../src/aiguard/noop')
const AIGuard = require('../../src/aiguard/sdk')

describe('AIGuard SDK', () => {
  const config = {
    flushInterval: 0,
    service: 'ai_guard_demo',
    env: 'test',
    apiKey: 'API_KEY',
    appKey: 'APP_KEY',
    protocolVersion: '0.4',
    aiguard: {
      enabled: true,
      endpoint: 'https://aiguard.com',
      timeout: 10_000
    },
    experimental: {
      aiguard: {
        maxMessagesLength: 16,
        maxContentSize: 512 * 1024
      }
    }
  }
  let tracer
  let aiguard

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
            arguments: '{ "operator": "+", "args": [2, 2] }'
          }
        },
      ],
    }
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

    aiguard = new AIGuard(tracer, config)

    return agent.load(null, [])
  })

  afterEach(() => {
    global.fetch = originalFetch
    agent.close()
  })

  const mockFetch = (options) => {
    global.fetch.resolves({
      status: options.status ?? 200,
      json: sinon.stub().resolves(options.body)
    })
  }

  const assertFetch = (messages) => {
    const postData = JSON.stringify(
      { data: { attributes: { messages, meta: { service: config.service, env: config.env } } } }
    )
    sinon.assert.calledOnceWithExactly(global.fetch,
      `${config.aiguard.endpoint}/evaluate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'DD-API-KEY': config.apiKey,
          'DD-APPLICATION-KEY': config.appKey
        },
        body: postData,
        signal: sinon.match.instanceOf(AbortSignal)
      }
    )
  }

  const assertAIGuardSpan = async (meta, metaStruct = null) => {
    await agent.assertFirstTraceSpan(span => {
      expect(span.name).to.equal('ai_guard')
      expect(span.resource).to.equal('ai_guard')
      expect(span.meta).to.deep.include(meta)
      if (metaStruct) {
        expect(msgpack.decode(span.meta_struct.ai_guard)).to.deep.equal(metaStruct)
      }
    }, { rejectFirst: true })
  }

  const testSuite = [
    { action: 'ALLOW', reason: 'Go ahead' },
    { action: 'DENY', reason: 'Nope' },
    { action: 'ABORT', reason: 'Kill it with fire' }
  ].flatMap(r => [
    { ...r, blocking: true },
    { ...r, blocking: false },
  ]).flatMap(r => [
    { ...r, suite: 'tool call', target: 'tool', messages: toolCall },
    { ...r, suite: 'tool output', target: 'tool', messages: toolOutput },
    { ...r, suite: 'prompt', target: 'prompt', messages: prompt }
  ])

  for (const { action, reason, blocking, suite, target, messages } of testSuite) {
    it(`test evaluate '${suite}' with ${action} action (blocking: ${blocking})`, async () => {
      mockFetch({ body: { data: { attributes: { action, reason, is_blocking_enabled: blocking } } } })
      const shouldBlock = action !== 'ALLOW' && blocking

      if (shouldBlock) {
        await rejects(
          () => aiguard.evaluate(messages, { block: true }),
          err => err.name === 'AIGuardAbortError' && err.reason === reason
        )
      } else {
        const evaluation = await aiguard.evaluate(messages, { block: true })
        expect(evaluation.action).to.equal(action)
        expect(evaluation.reason).to.equal(reason)
      }

      assertFetch(messages)
      await assertAIGuardSpan({
        'ai_guard.target': target,
        'ai_guard.action': action,
        'ai_guard.reason': reason,
        ...(target === 'tool' ? { 'ai_guard.tool_name': 'calc' } : {}),
        ...(shouldBlock ? { 'ai_guard.blocked': 'true', 'error.type': 'AIGuardAbortError' } : {})
      },
      { messages })
    })
  }

  it('test evaluate with API error', async () => {
    const errors = [{ status: 400, title: 'Internal server error' }]
    mockFetch({
      status: 400,
      body: { errors }
    })

    await rejects(
      () => aiguard.evaluate(toolCall),
      err =>
        err.name === 'AIGuardClientError' && JSON.stringify(err.errors) === JSON.stringify(errors)
    )

    assertFetch(toolCall)
    await assertAIGuardSpan({
      'ai_guard.target': 'tool',
      'error.type': 'AIGuardClientError'
    })
  })

  it('test evaluate with invalid JSON', async () => {
    mockFetch({ body: { message: 'This is an invalid JSON' } })

    await rejects(
      () => aiguard.evaluate(toolCall),
      err => err.name === 'AIGuardClientError'
    )

    assertFetch(toolCall)
    await assertAIGuardSpan({
      'ai_guard.target': 'tool',
      'error.type': 'AIGuardClientError'
    })
  })

  it('test evaluate with with missing action or response', async () => {
    mockFetch({ body: { data: { attributes: { reason: 'I miss something' } } } })

    await rejects(
      () => aiguard.evaluate(toolCall),
      err => err.name === 'AIGuardClientError'
    )

    assertFetch(toolCall)
    await assertAIGuardSpan({
      'ai_guard.target': 'tool',
      'error.type': 'AIGuardClientError'
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
      content: `This is a prompt: ${i}`
    }))
    mockFetch({
      body: { data: { attributes: { action: 'ALLOW', reason: 'OK', is_blocking_enabled: false } } }
    })

    await aiguard.evaluate(messages)

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
      body: { data: { attributes: { action: 'ALLOW', reason: 'OK', is_blocking_enabled: false } } }
    })

    await aiguard.evaluate(messages)

    assertFetch(messages)
    await assertAIGuardSpan(
      { 'ai_guard.target': 'prompt', 'ai_guard.action': 'ALLOW' },
      { messages: [{ role: 'user', content: content.slice(0, maxContent) }] }
    )
  })

  it('test required fields', () => {
    expect(
      () => new AIGuard(tracer, { aiguard: { endpoint: 'http://aiguard' } })
    ).to.throw('AIGuard: missing api and/or app keys, use env DD_API_KEY and DD_APP_KEY')
  })

  const sites = [
    { site: 'datad0g.com', endpoint: 'https://app.datad0g.com/api/v2/ai-guard' },
    { site: 'datadoghq.com', endpoint: 'https://app.datadoghq.com/api/v2/ai-guard' }
  ]
  for (const { site, endpoint } of sites) {
    it(`test endpoint discovery: ${site}`, () => {
      const newConfig = Object.assign({ site }, config)
      delete newConfig.aiguard.endpoint
      const client = new AIGuard(tracer, newConfig)
      expect(client._evaluateUrl.toString()).to.equal(`${endpoint}/evaluate`)
    })
  }
})
