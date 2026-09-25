'use strict'

const assert = require('node:assert/strict')
const { rejects } = require('node:assert/strict')
const { inspect, isDeepStrictEqual } = require('node:util')

const msgpack = require('@msgpack/msgpack')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { storage } = require('../../../datadog-core')
const aiguardAutoInstrumentation = require('../../src/aiguard')
const NoopAIGuard = require('../../src/aiguard/noop')
const { withRequest } = require('../../src/appsec/store')
const agent = require('../plugins/agent')
const { assertObjectContains } = require('../../../../integration-tests/helpers')

const tracerVersion = require('../../../../package.json').version
const telemetryMetrics = require('../../src/telemetry/metrics')
const aiguardMetrics = telemetryMetrics.manager.namespace('ai_guard')
const { USER_KEEP } = require('../../../../ext/priority')
const { HTTP_CLIENT_IP, NETWORK_CLIENT_IP } = require('../../../../ext/tags')
const { SAMPLING_MECHANISM_AI_GUARD, DECISION_MAKER_KEY } = require('../../src/constants')
const {
  EVENT_TAG_KEY,
  SOURCE_SDK,
  INTEGRATION_NONE,
  ERROR_TYPE_CLIENT,
  ERROR_TYPE_STATUS,
  ERROR_TYPE_RESPONSE,
  ERROR_TYPE_REDACTION,
} = require('../../src/aiguard/tags')

describe('AIGuard SDK', () => {
  const config = {
    flushInterval: 0,
    service: 'ai_guard_demo',
    env: 'test',
    DD_API_KEY: 'API_KEY',
    DD_APP_KEY: 'APP_KEY',
    protocolVersion: '0.4',
    aiguard: {
      DD_AI_GUARD_ENABLED: true,
      DD_AI_GUARD_ENDPOINT: 'https://aiguard.com',
      DD_AI_GUARD_MAX_MESSAGES_LENGTH: 16,
      DD_AI_GUARD_MAX_CONTENT_SIZE: 512 * 1024,
      DD_AI_GUARD_REDACTION_ENABLED: true,
      DD_AI_GUARD_TIMEOUT: 10_000,
    },
  }
  let tracer
  let aiguard
  let count

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

  let request
  let AIGuard

  beforeEach(async () => {
    tracer = await agent.load(null, [], config)

    request = sinon.stub()
    const Client = proxyquire('../../src/aiguard/client', { '../exporters/common/request': request })
    AIGuard = proxyquire('../../src/aiguard/sdk', { './client': Client })

    count = sinon.stub(aiguardMetrics, 'count').callsFake(() => ({ inc: sinon.spy() }))
    aiguardMetrics.metrics.clear()

    aiguard = new AIGuard(tracer, config)
  })

  afterEach(async () => {
    sinon.restore()
    aiguardAutoInstrumentation.disable()
    return agent.close()
  })

  const completeRequest = (callback, options) => {
    if (options.error) {
      callback(options.error)
      return
    }
    const status = options.status ?? 200
    const responseBody = JSON.stringify(options.body)
    if (status >= 200 && status <= 299) {
      callback(null, responseBody, status)
    } else {
      callback(Object.assign(new Error(`HTTP ${status}`), { responseBody }), null, status)
    }
  }

  const mockRequest = (options) => {
    request.callsFake((body, opts, callback) => completeRequest(callback, options))
  }

  const mockDeferredRequest = () => {
    let complete
    request.callsFake((body, opts, callback) => { complete = callback })
    return options => completeRequest(complete, options)
  }

  const assertRequest = (messages, url) => {
    const postData = JSON.stringify(
      { data: { attributes: { messages, meta: { service: config.service, env: config.env } } } }
    )
    sinon.assert.calledOnceWithExactly(request,
      postData,
      sinon.match({
        url: url ?? `${config.aiguard.DD_AI_GUARD_ENDPOINT}/evaluate`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'DD-API-KEY': config.DD_API_KEY,
          'DD-APPLICATION-KEY': config.DD_APP_KEY,
          'DD-AI-GUARD-VERSION': tracerVersion,
          'DD-AI-GUARD-SOURCE': 'SDK',
          'DD-AI-GUARD-LANGUAGE': 'nodejs',
        },
        timeout: config.aiguard.DD_AI_GUARD_TIMEOUT,
        signal: sinon.match.instanceOf(AbortSignal),
        retry: false,
        includeErrorResponseBody: true,
      }),
      sinon.match.func
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

  const sdkTags = { source: SOURCE_SDK, integration: INTEGRATION_NONE }

  const assertTelemetry = (metric, tags, incAmount = 1) => {
    if (metric === 'requests' && tags.error === false && !Object.hasOwn(tags, 'redacted')) {
      tags = { ...tags, redacted: false }
    }
    const metricCalls = count.getCalls().filter(call =>
      call.args[0] === metric && isDeepStrictEqual(call.args[1], tags)
    )
    assert.strictEqual(
      metricCalls.length,
      1,
      `Expected one telemetry count(${inspect(metric)}, ${inspect(tags)}), got ${metricCalls.length}`
    )
    sinon.assert.calledOnceWithExactly(metricCalls[0].returnValue.inc, incAmount)
  }

  const testSuite = [
    { action: 'ALLOW', reason: 'Go ahead' },
    { action: 'DENY', reason: 'Nope', tagProbs: { deny_everything: 0.8, test_deny: 0.2 } },
    { action: 'ABORT', reason: 'Kill it with fire', tagProbs: { alarm_tag: 0.3, abort_everything: 0.7 } },
  ].flatMap(r => [
    { ...r, blocking: true },
    { ...r, blocking: false },
  ]).flatMap(r => [
    { ...r, suite: 'tool call', target: 'tool', messages: toolCall },
    { ...r, suite: 'tool output', target: 'tool', messages: toolOutput },
    { ...r, suite: 'prompt', target: 'prompt', messages: prompt },
  ])

  for (const { action, reason, tagProbs, blocking, suite, target, messages } of testSuite) {
    it(`test evaluate '${suite}' with ${action} action (blocking: ${blocking})`, async () => {
      const attributes = { action, reason, is_blocking_enabled: blocking }
      if (tagProbs) {
        attributes.tags = Object.keys(tagProbs)
        attributes.tag_probs = tagProbs
      }
      mockRequest({ body: { data: { attributes } } })
      const shouldBlock = action !== 'ALLOW' && blocking

      if (shouldBlock) {
        await rejects(
          () => aiguard.evaluate(messages, { block: true }),
          err => err.name === 'AIGuardAbortError' && err.reason === reason &&
            isDeepStrictEqual(err.tags, attributes.tags) &&
            isDeepStrictEqual(err.tagProbabilities, attributes.tag_probs) && JSON.stringify(err.sds) === '[]'
        )
      } else {
        const evaluation = await aiguard.evaluate(messages, { block: true })
        assert.strictEqual(evaluation.action, action)
        assert.strictEqual(evaluation.reason, reason)
        if (tagProbs) {
          assert.deepStrictEqual(evaluation.tags, attributes.tags)
          assert.deepStrictEqual(evaluation.tagProbabilities, attributes.tag_probs)
        }
        assert.deepStrictEqual(evaluation.sds, [])
        assert.notStrictEqual(evaluation.messages, messages)
        assert.deepStrictEqual(evaluation.messages, messages)
      }

      assertTelemetry('requests', { action, error: false, block: shouldBlock, ...sdkTags })
      assertRequest(messages)
      await assertAIGuardSpan({
        'ai_guard.target': target,
        'ai_guard.action': action,
        'ai_guard.reason': reason,
        ...(target === 'tool' ? { 'ai_guard.tool_name': 'calc' } : {}),
        ...(shouldBlock ? { 'ai_guard.blocked': 'true', 'error.type': 'AIGuardAbortError' } : {}),
      },
      {
        messages,
        ...(attributes.tags ? { attack_categories: attributes.tags } : {}),
        ...(attributes.tag_probs ? { tag_probs: attributes.tag_probs } : {}),
      })
    })
  }

  const blockDefaultsSuite = [
    { description: 'no options', opts: undefined, shouldBlock: true },
    { description: 'empty options', opts: {}, shouldBlock: true },
    { description: 'explicit block: false', opts: { block: false }, shouldBlock: false },
  ]
  for (const { description, opts, shouldBlock } of blockDefaultsSuite) {
    it(`test evaluate block defaults to remote is_blocking_enabled (${description})`, async () => {
      mockRequest({
        body: {
          data: {
            attributes: { action: 'DENY', reason: 'Nope', tags: ['deny'], is_blocking_enabled: true },
          },
        },
      })

      if (shouldBlock) {
        await rejects(
          () => aiguard.evaluate(prompt, opts),
          err => err.name === 'AIGuardAbortError' && err.reason === 'Nope'
        )
      } else {
        const evaluation = await aiguard.evaluate(prompt, opts)
        assert.strictEqual(evaluation.action, 'DENY')
        assert.notStrictEqual(evaluation.messages, prompt)
        assert.deepStrictEqual(evaluation.messages, prompt)
      }

      assertTelemetry('requests', { error: false, action: 'DENY', block: shouldBlock, ...sdkTags })
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
    mockRequest({
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
    assert.notStrictEqual(result.messages, messages)
    assert.deepStrictEqual(result.messages, messages)
    await assertAIGuardSpan(
      { 'ai_guard.target': 'prompt', 'ai_guard.action': 'ALLOW' },
      { messages, sds: sdsFindings }
    )
  })

  it('test evaluate with empty sds_findings', async () => {
    const messages = [{ role: 'user', content: 'Hello' }]
    mockRequest({
      body: {
        data: {
          attributes: { action: 'ALLOW', reason: 'OK', tags: [], sds_findings: [], is_blocking_enabled: false },
        },
      },
    })

    const result = await aiguard.evaluate(messages)

    assert.deepStrictEqual(result.sds, [])
    assert.notStrictEqual(result.messages, messages)
    assert.deepStrictEqual(result.messages, messages)
    assert.deepStrictEqual(result.redactionReplacements, [])
    await assertAIGuardSpan(
      { 'ai_guard.target': 'prompt', 'ai_guard.action': 'ALLOW' },
      { messages }
    )
  })

  it('returns redacted messages and reports them in meta-struct without mutating the input', async () => {
    const messages = [{ role: 'user', content: 'My SSN is 123-45-6789' }]
    const redactionReplacements = [
      { path: 'messages[0].content', replacement: 'My SSN is <REDACTED>' },
    ]
    mockRequest({
      body: {
        data: {
          attributes: {
            action: 'ALLOW',
            reason: 'Sensitive data redacted.',
            redaction_replacements: redactionReplacements,
            is_blocking_enabled: true,
          },
        },
      },
    })

    const result = await aiguard.evaluate(messages)

    assert.notStrictEqual(result.messages, messages)
    assert.deepStrictEqual(result.messages, [{ role: 'user', content: 'My SSN is <REDACTED>' }])
    assert.deepStrictEqual(result.redactionReplacements, redactionReplacements)
    assert.strictEqual(messages[0].content, 'My SSN is 123-45-6789')
    assertRequest(messages)
    assertTelemetry('requests', {
      action: 'ALLOW',
      error: false,
      block: false,
      redacted: true,
      ...sdkTags,
    })
    await assertAIGuardSpan(
      { 'ai_guard.target': 'prompt', 'ai_guard.action': 'ALLOW', 'ai_guard.redacted': 'true' },
      { messages: [{ role: 'user', content: 'My SSN is <REDACTED>' }] }
    )
  })

  it('uses one message snapshot when the caller mutates messages while evaluation is pending', async () => {
    const messages = [{ role: 'user', content: 'My SSN is 123-45-6789' }]
    const originalMessages = [{ role: 'user', content: 'My SSN is 123-45-6789' }]
    const callerMutation = { role: 'system', content: 'Caller mutation' }
    const resolveRequest = mockDeferredRequest()

    const evaluation = aiguard.evaluate(messages)
    messages.unshift(callerMutation)
    resolveRequest({
      body: {
        data: {
          attributes: {
            action: 'ALLOW',
            redaction_replacements: [
              { path: 'messages[0].content', replacement: 'My SSN is <REDACTED>' },
            ],
          },
        },
      },
    })

    const result = await evaluation

    assertRequest(originalMessages)
    assert.deepStrictEqual(result.messages, [{ role: 'user', content: 'My SSN is <REDACTED>' }])
    assert.deepStrictEqual(messages, [callerMutation, ...originalMessages])
    await assertAIGuardSpan(
      { 'ai_guard.redacted': 'true' },
      { messages: [{ role: 'user', content: 'My SSN is <REDACTED>' }] }
    )
  })

  it('returns complete redacted messages while truncating only the meta-struct copy', async () => {
    const maxContentSize = 12
    const atLimit = 'A'.repeat(maxContentSize)
    const limited = new AIGuard(tracer, {
      ...config,
      aiguard: {
        ...config.aiguard,
        DD_AI_GUARD_MAX_CONTENT_SIZE: maxContentSize,
      },
    })
    const messages = [{
      role: 'user',
      content: [
        { type: 'input_text', text: 'My SSN is 123-45-6789' },
        { type: 'input_text', text: atLimit },
        { type: 'input_image', image_url: { url: 'https://example.com/image.png' } },
      ],
    }]
    const replacement = 'My SSN is <REDACTED>'
    mockRequest({
      body: {
        data: {
          attributes: {
            action: 'ALLOW',
            redaction_replacements: [{ path: 'messages[0].content[0].text', replacement }],
          },
        },
      },
    })

    const result = await limited.evaluate(messages)

    assert.deepStrictEqual(result.messages, [{
      role: 'user',
      content: [
        { type: 'input_text', text: replacement },
        { type: 'input_text', text: atLimit },
        { type: 'input_image', image_url: { url: 'https://example.com/image.png' } },
      ],
    }])
    assertTelemetry('truncated', { type: 'content', ...sdkTags })
    assert.strictEqual(count.getCalls().filter(call => call.args[0] === 'truncated').length, 1)
    await assertAIGuardSpan(
      { 'ai_guard.redacted': 'true' },
      {
        messages: [{
          role: 'user',
          content: [
            { type: 'input_text', text: replacement.slice(0, maxContentSize) },
            { type: 'input_text', text: '' },
            { type: 'input_image', image_url: { url: 'https://example.com/image.png' } },
          ],
        }],
      }
    )
  })

  it('skips nullish structured content parts when reporting a successful evaluation', async () => {
    const messages = [{
      role: 'user',
      content: [
        null,
        undefined,
        { type: 'input_text', text: 'Describe this image' },
        { type: 'input_image', image_url: { url: 'https://example.com/image.png' } },
      ],
    }]
    mockRequest({
      body: { data: { attributes: { action: 'ALLOW', reason: 'OK', is_blocking_enabled: false } } },
    })

    const result = await aiguard.evaluate(messages)

    assert.deepStrictEqual(result.messages, messages)
    assertRequest(messages)
    await assertAIGuardSpan(
      { 'ai_guard.target': 'prompt', 'ai_guard.action': 'ALLOW' },
      {
        messages: [{
          role: 'user',
          content: [
            { type: 'input_text', text: 'Describe this image' },
            { type: 'input_image', image_url: { url: 'https://example.com/image.png' } },
          ],
        }],
      }
    )
  })

  it('redacts blocked payloads in meta-struct without adding messages to the abort error', async () => {
    const messages = [{ role: 'user', content: 'My SSN is 123-45-6789' }]
    mockRequest({
      body: {
        data: {
          attributes: {
            action: 'DENY',
            reason: 'Sensitive data blocked.',
            redaction_replacements: [
              { path: 'messages[0].content', replacement: 'My SSN is <REDACTED>' },
            ],
            is_blocking_enabled: true,
          },
        },
      },
    })

    await rejects(
      () => aiguard.evaluate(messages),
      err => err.name === 'AIGuardAbortError' && !Object.hasOwn(err, 'messages')
    )

    await assertAIGuardSpan(
      {
        'ai_guard.action': 'DENY',
        'ai_guard.blocked': 'true',
        'ai_guard.redacted': 'true',
        'error.type': 'AIGuardAbortError',
      },
      { messages: [{ role: 'user', content: 'My SSN is <REDACTED>' }] }
    )
  })

  it('reports malformed replacements and applies valid siblings', async () => {
    const messages = [
      { role: 'system', content: 'ops@acme.io' },
      { role: 'user', content: '123-45-6789' },
    ]
    mockRequest({
      body: {
        data: {
          attributes: {
            action: 'ALLOW',
            redaction_replacements: [
              { path: 'messages[0].content', replacement: '<REDACTED>' },
              { path: 'messages[8].content', replacement: 'missing' },
              { path: 'messages.invalid.content', replacement: 'malformed' },
            ],
          },
        },
      },
    })

    const result = await aiguard.evaluate(messages)

    assert.deepStrictEqual(result.messages, [
      { role: 'system', content: '<REDACTED>' },
      { role: 'user', content: '123-45-6789' },
    ])
    assertTelemetry('error', { type: ERROR_TYPE_REDACTION, ...sdkTags }, 2)
    assertTelemetry('requests', {
      action: 'ALLOW',
      error: false,
      block: false,
      redacted: true,
      ...sdkTags,
    })
    await assertAIGuardSpan(
      { 'ai_guard.redacted': 'true' },
      {
        messages: [
          { role: 'system', content: '<REDACTED>' },
          { role: 'user', content: '123-45-6789' },
        ],
      }
    )
  })

  it('reports originals when every replacement fails', async () => {
    const messages = [{ role: 'user', content: '123-45-6789' }]
    mockRequest({
      body: {
        data: {
          attributes: {
            action: 'ALLOW',
            tags: ['pii'],
            sds_findings: [{ category: 'pii', matched_text: '123-45-6789' }],
            redaction_replacements: [{ path: 'messages[8].content', replacement: '<REDACTED>' }],
          },
        },
      },
    })

    const result = await aiguard.evaluate(messages)

    assert.deepStrictEqual(result.messages, messages)
    assert.deepStrictEqual(result.sds, [{ category: 'pii', matched_text: '123-45-6789' }])
    assertTelemetry('error', { type: ERROR_TYPE_REDACTION, ...sdkTags })
    assertTelemetry('requests', {
      action: 'ALLOW',
      error: false,
      block: false,
      redacted: false,
      ...sdkTags,
    })
    await assertAIGuardSpan(
      { 'ai_guard.redacted': 'false' },
      {
        messages,
        attack_categories: ['pii'],
        sds: [{ category: 'pii', matched_text: '123-45-6789' }],
      }
    )
  })

  it('reports a falsy non-array replacement collection as a redaction error', async () => {
    const messages = [{ role: 'user', content: '123-45-6789' }]
    mockRequest({
      body: {
        data: {
          attributes: {
            action: 'ALLOW',
            redaction_replacements: false,
          },
        },
      },
    })

    const result = await aiguard.evaluate(messages)

    assert.deepStrictEqual(result.messages, messages)
    assert.deepStrictEqual(result.redactionReplacements, [])
    assertTelemetry('error', { type: ERROR_TYPE_REDACTION, ...sdkTags })
    assertTelemetry('requests', {
      action: 'ALLOW',
      error: false,
      block: false,
      redacted: false,
      ...sdkTags,
    })
    await assertAIGuardSpan(
      { 'ai_guard.redacted': 'false' },
      { messages }
    )
  })

  it('keeps originals and omits redaction tags when the kill-switch is off', async () => {
    const disabled = new AIGuard(tracer, {
      ...config,
      aiguard: {
        ...config.aiguard,
        DD_AI_GUARD_REDACTION_ENABLED: false,
      },
    })
    const messages = [{ role: 'user', content: 'My SSN is 123-45-6789' }]
    const redactionReplacements = [
      { path: 'messages[0].content', replacement: 'My SSN is <REDACTED>' },
    ]
    mockRequest({
      body: {
        data: {
          attributes: {
            action: 'ALLOW',
            redaction_replacements: redactionReplacements,
          },
        },
      },
    })

    const result = await disabled.evaluate(messages)

    assert.strictEqual(result.messages, messages)
    assert.strictEqual(result.messages[0], messages[0])
    assert.deepStrictEqual(result.messages, messages)
    assert.deepStrictEqual(result.redactionReplacements, redactionReplacements)
    const requestMetricCall = count.getCalls().find(call => call.args[0] === 'requests')
    assert.ok(!Object.hasOwn(requestMetricCall.args[1], 'redacted'))
    await agent.assertFirstTraceSpan(span => {
      assert.ok(!Object.hasOwn(span.meta, 'ai_guard.redacted'))
      assert.deepStrictEqual(msgpack.decode(span.meta_struct.ai_guard), { messages })
    }, { rejectFirst: true })
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
    mockRequest({
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
    await assertAIGuardSpan(
      { 'ai_guard.blocked': 'true', 'error.type': 'AIGuardAbortError' },
      {
        messages,
        attack_categories: ['pii'],
        sds: sdsFindings,
      }
    )
  })

  it('test evaluate with API error', async () => {
    const errors = [{ status: 400, title: 'Internal server error' }]
    mockRequest({
      status: 400,
      body: { errors },
    })

    await rejects(
      () => aiguard.evaluate(toolCall),
      err =>
        err.name === 'AIGuardClientError' && JSON.stringify(err.errors) === JSON.stringify(errors)
    )

    assertTelemetry('requests', { error: true, ...sdkTags })
    assertTelemetry('error', { type: ERROR_TYPE_STATUS, ...sdkTags })
    assertRequest(toolCall)
    await assertAIGuardSpan({
      'ai_guard.target': 'tool',
      'error.type': 'AIGuardClientError',
    }, { messages: toolCall })
  })

  it('reports the message snapshot when a failed request settles after caller mutation', async () => {
    const messages = [{ role: 'user', content: 'Original message' }]
    const originalMessages = [{ role: 'user', content: 'Original message' }]
    const callerMutation = { role: 'system', content: 'Caller mutation' }
    const resolveRequest = mockDeferredRequest()

    const evaluation = aiguard.evaluate(messages)
    messages.unshift(callerMutation)
    resolveRequest({ status: 503, body: { errors: [{ title: 'Unavailable' }] } })

    await rejects(
      () => evaluation,
      err => err.name === 'AIGuardClientError' && err.message === 'AI Guard service call failed, status 503'
    )

    assertRequest(originalMessages)
    assert.deepStrictEqual(messages, [callerMutation, ...originalMessages])
    await assertAIGuardSpan(
      { 'ai_guard.target': 'prompt', 'error.type': 'AIGuardClientError' },
      { messages: originalMessages }
    )
  })

  it('test evaluate with API exception', async () => {
    mockRequest({
      error: new Error('Boom!!!'),
    })

    await rejects(
      () => aiguard.evaluate(toolCall),
      err =>
        err.name === 'AIGuardClientError' && err.message === 'Unexpected error calling AI Guard service: Boom!!!',
    )

    assertTelemetry('requests', { error: true, ...sdkTags })
    assertTelemetry('error', { type: ERROR_TYPE_CLIENT, ...sdkTags })
    assertRequest(toolCall)
    await assertAIGuardSpan({
      'ai_guard.target': 'tool',
      'error.type': 'AIGuardClientError',
    }, { messages: toolCall })
  })

  it('does not mask a client error when structured content contains nullish parts', async () => {
    const messages = [{ role: 'user', content: [null, { type: 'input_text', text: 'Are you sure?' }] }]
    mockRequest({ error: new Error('Boom!!!') })

    await rejects(
      () => aiguard.evaluate(messages),
      err => err.name === 'AIGuardClientError' && err.message === 'Unexpected error calling AI Guard service: Boom!!!'
    )

    assertTelemetry('requests', { error: true, ...sdkTags })
    assertTelemetry('error', { type: ERROR_TYPE_CLIENT, ...sdkTags })
    assertRequest(messages)
    await assertAIGuardSpan(
      { 'ai_guard.target': 'prompt', 'error.type': 'AIGuardClientError' },
      { messages: [{ role: 'user', content: [{ type: 'input_text', text: 'Are you sure?' }] }] }
    )
  })

  it('test evaluate with invalid JSON', async () => {
    mockRequest({ body: { message: 'This is an invalid JSON' } })

    await rejects(
      () => aiguard.evaluate(toolCall),
      err => err.name === 'AIGuardClientError'
    )

    assertTelemetry('requests', { error: true, ...sdkTags })
    assertTelemetry('error', { type: ERROR_TYPE_RESPONSE, ...sdkTags })
    assertRequest(toolCall)
    await assertAIGuardSpan({
      'ai_guard.target': 'tool',
      'error.type': 'AIGuardClientError',
    }, { messages: toolCall })
  })

  it('test evaluate with with missing action or response', async () => {
    mockRequest({ body: { data: { attributes: { reason: 'I miss something' } } } })

    await rejects(
      () => aiguard.evaluate(toolCall),
      err => err.name === 'AIGuardClientError'
    )

    assertTelemetry('requests', { error: true, ...sdkTags })
    assertTelemetry('error', { type: ERROR_TYPE_RESPONSE, ...sdkTags })
    assertRequest(toolCall)
    await assertAIGuardSpan({
      'ai_guard.target': 'tool',
      'error.type': 'AIGuardClientError',
    }, { messages: toolCall })
  })

  it('test noop implementation', async () => {
    const noop = new NoopAIGuard()
    const result = await noop.evaluate(prompt)
    assert.strictEqual(result.action, 'ALLOW')
    assert.strictEqual(result.reason, 'AI Guard is not enabled')
    assert.strictEqual(result.messages, prompt)
    assert.deepStrictEqual(result.redactionReplacements, [])
  })

  it('test message length truncation', async () => {
    const maxMessages = config.aiguard.DD_AI_GUARD_MAX_MESSAGES_LENGTH
    const messages = Array.from({ length: maxMessages + 1 }, (_, i) => ({
      role: 'user',
      content: `This is a prompt: ${i}`,
    }))
    mockRequest({
      body: { data: { attributes: { action: 'ALLOW', reason: 'OK', is_blocking_enabled: false } } },
    })

    await aiguard.evaluate(messages)

    assertTelemetry('truncated', { type: 'messages', ...sdkTags })
    assertRequest(messages)
    await assertAIGuardSpan(
      { 'ai_guard.target': 'prompt', 'ai_guard.action': 'ALLOW' },
      { messages: messages.slice(-maxMessages) }
    )
  })

  it('test message content truncation', async () => {
    const maxContent = config.aiguard.DD_AI_GUARD_MAX_CONTENT_SIZE
    const content = Array(maxContent + 1).fill('A').join('')
    const messages = [{ role: 'user', content }]
    mockRequest({
      body: { data: { attributes: { action: 'ALLOW', reason: 'OK', is_blocking_enabled: false } } },
    })

    await aiguard.evaluate(messages)

    assertTelemetry('truncated', { type: 'content', ...sdkTags })
    assertRequest(messages)
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
    mockRequest({
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
    const client = new AIGuard(tracer, { aiguard: { DD_AI_GUARD_ENDPOINT: 'http://aiguard' } })
    const result = await client.evaluate(toolCall)
    assert.strictEqual(result.action, 'ALLOW')
    assert.strictEqual(result.reason, 'AI Guard is not enabled')
  })

  it('test ai_guard.event tag on root span', async () => {
    mockRequest({
      body: { data: { attributes: { action: 'ALLOW', reason: 'OK', is_blocking_enabled: false } } },
    })
    await tracer.trace('root', async () => {
      await aiguard.evaluate(prompt, { block: false })
    })
    await agent.assertSomeTraces(traces => {
      assert.strictEqual(traces[0].length, 2, 'Trace should contain two spans root + ai_guard')
      for (const span of traces[0]) {
        if (span.name === 'root') {
          assert.strictEqual(span.meta[EVENT_TAG_KEY], 'true')
        } else {
          assert.ok(!Object.hasOwn(span.meta, EVENT_TAG_KEY), `Available keys: ${inspect(Object.keys(span.meta))}`)
        }
      }
    })
  })

  it('copies the client ip of the active request onto the root span', async () => {
    mockRequest({
      body: { data: { attributes: { action: 'ALLOW', reason: 'OK', is_blocking_enabled: false } } },
    })

    const req = { headers: { 'x-forwarded-for': '8.8.8.8' }, socket: { remoteAddress: '10.0.0.1' } }
    await tracer.trace('root', async () => {
      const legacyStorage = storage('legacy')
      await legacyStorage.run(withRequest(legacyStorage.getStore(), req), () =>
        aiguard.evaluate(prompt, { block: false })
      )
    })

    await agent.assertSomeTraces(traces => {
      const rootSpan = traces[0].find(span => span.name === 'root')
      assertObjectContains(rootSpan.meta, {
        [HTTP_CLIENT_IP]: '8.8.8.8',
        [NETWORK_CLIENT_IP]: '10.0.0.1',
      })
    })
  })

  it('parents the ai_guard span under the explicit childOf span', async () => {
    mockRequest({
      body: { data: { attributes: { action: 'ALLOW', reason: 'OK', is_blocking_enabled: false } } },
    })

    // Create the parent span and evaluate outside its active scope, so only the explicit
    // `childOf` can establish the parent-child relationship (not the active async context).
    const parent = tracer.startSpan('explicit-parent')
    await aiguard.evaluate(prompt, { childOf: parent })
    parent.finish()

    await agent.assertSomeTraces(traces => {
      const parentSpan = traces[0].find(span => span.name === 'explicit-parent')
      const guardSpan = traces[0].find(span => span.name === 'ai_guard')
      assert.ok(parentSpan && guardSpan, 'expected both explicit-parent and ai_guard spans')
      assert.strictEqual(guardSpan.parent_id.toString(), parentSpan.span_id.toString())
    })
  })

  const sites = [
    { site: 'datad0g.com', endpoint: 'https://app.datad0g.com/api/v2/ai-guard' },
    { site: 'datadoghq.com', endpoint: 'https://app.datadoghq.com/api/v2/ai-guard' },
    { site: 'ddog-gov.com', endpoint: 'https://app.ddog-gov.com/api/v2/ai-guard' },
    { site: 'us3.datadoghq.com', endpoint: 'https://us3.datadoghq.com/api/v2/ai-guard' },
    { site: 'ap1.datadoghq.com', endpoint: 'https://ap1.datadoghq.com/api/v2/ai-guard' },
  ]
  for (const { site, endpoint } of sites) {
    it(`test endpoint discovery: ${site}`, async () => {
      const { DD_AI_GUARD_ENDPOINT: _discardedEndpoint, ...aiguard } = config.aiguard
      const newConfig = { ...config, site, aiguard }
      const client = new AIGuard(tracer, newConfig)
      mockRequest({
        body: { data: { attributes: { action: 'ALLOW', reason: 'OK', is_blocking_enabled: false } } },
      })

      await client.evaluate(toolCall)

      assertRequest(toolCall, `${endpoint}/evaluate`)
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
      mockRequest({
        body: { data: { attributes: { action: 'ALLOW', reason: 'OK', tags: [], is_blocking_enabled: false } } },
      })

      await tracer.trace('root', async () => {
        await aiguard.evaluate(prompt)
      })

      await assertRootSpanKept()
    })

    it('sets USER_KEEP on root span after DENY evaluation (non-blocking)', async () => {
      mockRequest({
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
        mockRequest({
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
      mockRequest({
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
