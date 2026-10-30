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
    version: '1.0.0',
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
        url: new URL(url ?? `${config.aiguard.DD_AI_GUARD_ENDPOINT}/evaluate`),
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

  describe('extra_tags and extra_metastruct', () => {
    const messages = [{ role: 'user', content: 'What is 2 + 2' }]
    const evaluateId = '8f1c6a52-0a43-4c3e-9b8e-2d6f4f1e7a90'
    const fields = ['extra_tags', 'extra_metastruct']

    // The backend sends lists of key/value entries because dotted keys are not valid JSON:API members.
    const kv = (mapping) => Object.entries(mapping).map(([key, value]) => ({ key, value }))

    /**
     * @param {{ tags?: unknown, metastruct?: unknown, attributes?: object, id?: string }} options
     */
    const mockExtra = ({ tags, metastruct, attributes = {}, id = evaluateId }) => {
      mockRequest({
        body: {
          data: {
            id,
            attributes: { action: 'ALLOW', ...attributes, extra_tags: tags, extra_metastruct: metastruct },
          },
        },
      })
    }

    const assertSpan = (assertions) => agent.assertFirstTraceSpan(span => {
      assert.strictEqual(span.name, 'ai_guard')
      assertions(span, msgpack.decode(span.meta_struct.ai_guard))
    }, { rejectFirst: true })

    const assertEvaluationUnchanged = (result) => {
      assert.strictEqual(result.action, 'ALLOW')
      assert.strictEqual(result.reason, 'ok')
      assertTelemetry('requests', { action: 'ALLOW', error: false, block: false, ...sdkTags })
      sinon.assert.neverCalledWith(count, 'error')
    }

    it('sets string extra_tags on the span under the returned key', async () => {
      mockExtra({ tags: kv({ 'ai_guard.policy_name': 'newsroom-default', 'custom_context.tenant': 'newsroom' }) })

      const result = await aiguard.evaluate(messages)

      assert.strictEqual(result.action, 'ALLOW')
      await assertSpan((span, metaStruct) => {
        assert.strictEqual(span.meta['ai_guard.policy_name'], 'newsroom-default')
        assert.strictEqual(span.meta['custom_context.tenant'], 'newsroom')
        assert.ok(!Object.hasOwn(span.meta, 'ai_guard.custom_context.tenant'))
        assert.deepStrictEqual(metaStruct, { messages })
      })
    })

    it('reads the evaluate id from the backend response document', async () => {
      const tagProbs = { jailbreak: 0.01 }
      mockRequest({
        body: {
          data: {
            id: evaluateId,
            type: 'evaluations',
            attributes: {
              action: 'ALLOW',
              reason: 'No rule match.',
              tag_probs: tagProbs,
              global_prob: 0.01,
              extra_tags: [{ key: 'ai_guard.evaluate_id', value: evaluateId }],
            },
          },
        },
      })

      const result = await aiguard.evaluate(messages)

      assert.strictEqual(result.action, 'ALLOW')
      await assertSpan((span, metaStruct) => {
        assert.strictEqual(span.meta['ai_guard.evaluate_id'], evaluateId)
        assert.ok(!Object.hasOwn(span.meta, 'global_prob'))
        assert.ok(!Object.hasOwn(span.metrics, 'global_prob'))
        assert.deepStrictEqual(metaStruct, { messages, tag_probs: tagProbs })
      })
    })

    it('adds extra_metastruct objects, arrays and scalars to the meta-struct only', async () => {
      const policyMatch = { rule: 'credit_card', categories: ['pii', 'financial'] }
      const matchedRules = [{ id: 'r1', action: 'DENY' }, { id: 'r2', action: 'ALLOW' }]
      mockExtra({
        metastruct: kv({ policy_match: policyMatch, matched_rules: matchedRules, policy_version: 'v3' }),
      })

      await aiguard.evaluate(messages)

      await assertSpan((span, metaStruct) => {
        assert.deepStrictEqual(metaStruct, {
          messages,
          policy_match: policyMatch,
          matched_rules: matchedRules,
          policy_version: 'v3',
        })
        for (const key of ['policy_match', 'matched_rules', 'policy_version']) {
          assert.ok(!Object.hasOwn(span.meta, key), `Unexpected tag ${key}`)
          assert.ok(!Object.hasOwn(span.metrics, key), `Unexpected metric ${key}`)
        }
      })
    })

    it('skips non-string extra_tags values without moving them to the meta-struct', async () => {
      mockExtra({
        tags: kv({
          'ai_guard.number': 7,
          'ai_guard.boolean': true,
          'ai_guard.object': { policy: 'default' },
          'ai_guard.array': ['a', 'b'],
          'ai_guard.null': null,
          'ai_guard.valid': 'kept',
        }),
        attributes: { reason: 'ok' },
      })

      const result = await aiguard.evaluate(messages)

      assertEvaluationUnchanged(result)
      await assertSpan((span, metaStruct) => {
        assert.strictEqual(span.meta['ai_guard.valid'], 'kept')
        const skipped = ['ai_guard.number', 'ai_guard.boolean', 'ai_guard.object', 'ai_guard.array', 'ai_guard.null']
        for (const key of skipped) {
          assert.ok(!Object.hasOwn(span.meta, key), `Unexpected tag ${key}`)
          assert.ok(!Object.hasOwn(span.metrics, key), `Unexpected metric ${key}`)
        }
        assert.deepStrictEqual(metaStruct, { messages })
      })
    })

    it('skips extra_metastruct entries without a value', async () => {
      mockExtra({ metastruct: [{ key: 'empty', value: null }, { key: 'missing' }, { key: 'kept', value: false }] })

      await aiguard.evaluate(messages)

      await assertSpan((span, metaStruct) => {
        assert.deepStrictEqual(metaStruct, { messages, kept: false })
      })
    })

    it('keeps the last value of a repeated key', async () => {
      mockExtra({
        tags: [{ key: 'ai_guard.policy', value: 'v1' }, { key: 'ai_guard.policy', value: 'v2' }],
        metastruct: [{ key: 'policy', value: ['v1'] }, { key: 'policy', value: ['v2'] }],
      })

      await aiguard.evaluate(messages)

      await assertSpan((span, metaStruct) => {
        assert.strictEqual(span.meta['ai_guard.policy'], 'v2')
        assert.deepStrictEqual(metaStruct, { messages, policy: ['v2'] })
      })
    })

    it('never overrides tags and meta-struct keys computed by the tracer', async () => {
      const sdsFindings = [{ rule_tag: 'email', category: 'pii' }]
      const tagProbs = { jailbreak: 0.1 }
      mockExtra({
        tags: kv({
          'ai_guard.action': 'DENY',
          'ai_guard.reason': 'forged',
          'ai_guard.target': 'tool',
          'ai_guard.tool_name': 'fake_tool',
          'ai_guard.blocked': 'true',
          'ai_guard.redacted': 'true',
          'ai_guard.event': 'false',
          'ai_guard.http.useragent': 'forged-agent/1.0',
          'ai_guard.http.client_ip': '6.6.6.6',
          'ai_guard.network.client.ip': '6.6.6.6',
          'ai_guard.usr.id': 'forged-user',
          'ai_guard.usr.session_id': 'forged-session',
          'ai_guard.backend_tag': 'kept',
        }),
        metastruct: kv({
          messages: [{ role: 'user', content: 'forged' }],
          attack_categories: ['forged'],
          sds: [{ forged: true }],
          tag_probs: { forged: 1 },
        }),
        attributes: { reason: 'fine', sds_findings: sdsFindings, tag_probs: tagProbs },
      })

      const result = await aiguard.evaluate(messages)

      assert.strictEqual(result.action, 'ALLOW')
      assert.strictEqual(result.reason, 'fine')
      await assertSpan((span, metaStruct) => {
        assert.strictEqual(span.meta['ai_guard.action'], 'ALLOW')
        assert.strictEqual(span.meta['ai_guard.reason'], 'fine')
        assert.strictEqual(span.meta['ai_guard.target'], 'prompt')
        assert.strictEqual(span.meta['ai_guard.redacted'], 'false')
        assert.strictEqual(span.meta['ai_guard.event'], 'true')
        assert.strictEqual(span.meta['ai_guard.backend_tag'], 'kept')
        for (const key of [
          'ai_guard.tool_name',
          'ai_guard.blocked',
          'ai_guard.http.useragent',
          'ai_guard.http.client_ip',
          'ai_guard.network.client.ip',
          'ai_guard.usr.id',
          'ai_guard.usr.session_id',
        ]) {
          assert.ok(!Object.hasOwn(span.meta, key), `Unexpected tag ${key}`)
        }
        // Conditional tracer keys (attack_categories here) stay absent rather than being filled in.
        assert.deepStrictEqual(metaStruct, { messages, sds: sdsFindings, tag_probs: tagProbs })
      })
    })

    it('never sets span-control keys', async () => {
      mockExtra({
        tags: kv({
          'manual.drop': 'true',
          'manual.keep': 'true',
          'sampling.priority': '-1',
          'service.name': 'forged-service',
          'resource.name': 'forged-resource',
          'span.type': 'forged-type',
          'span.kind': 'server',
          '_dd.measured': '0',
          '_dd.base_service': 'forged-base',
          error: 'true',
          'error.type': 'ForgedError',
          'error.message': 'forged',
          'error.stack': 'forged',
          'service.version': 'forged-version',
          version: 'forged-version',
          env: 'forged-env',
          'analytics.event': 'true',
          '_dd.hostname': 'forged-host',
          '_dd.origin': 'forged-origin',
        }),
      })

      const result = await aiguard.evaluate(messages)

      assert.strictEqual(result.action, 'ALLOW')
      await assertSpan(span => {
        assert.strictEqual(span.service, config.service)
        assert.strictEqual(span.resource, 'ai_guard')
        assert.strictEqual(span.type, undefined)
        assert.strictEqual(span.error, 0)
        assert.strictEqual(span.metrics._sampling_priority_v1, USER_KEEP)
        assert.ok(!Object.hasOwn(span.metrics, '_dd1.sr.eausr'))
        assert.ok(!Object.hasOwn(span.metrics, '_dd.hostname'))
        // tracer.trace marks its spans as measured by default.
        assert.strictEqual(span.metrics['_dd.measured'], 1)
        for (const key of [
          'manual.drop',
          'manual.keep',
          'sampling.priority',
          'span.kind',
          '_dd.measured',
          '_dd.base_service',
          '_dd.hostname',
          '_dd.origin',
          'analytics.event',
          'error.type',
          'error.message',
          'error.stack',
          'service.version',
        ]) {
          assert.ok(!Object.hasOwn(span.meta, key), `Unexpected tag ${key}`)
        }
        assert.strictEqual(span.meta.version, config.version)
        assert.strictEqual(span.meta.env, config.env)
      })
    })

    it('never overwrites tracer-internal keys written by the span formatter', async () => {
      mockExtra({
        tags: kv({
          '_dd.top_level': '0',
          '_dd.rule_psr': '0.5',
          '_dd1.sr.eausr': '1',
          '_dd.p.dm': 'forged',
          '_dd.tags.process': 'forged',
          '_dd.custom': 'x',
          _sampling_priority_v1: '0',
          process_id: '1',
          language: 'forged',
          'runtime-id': 'forged',
          'dd.custom': 'kept',
        }),
      })

      const result = await aiguard.evaluate(messages)

      assert.strictEqual(result.action, 'ALLOW')
      await assertSpan(span => {
        // The SDK span is the root span here, so the formatter writes its root and chunk tags on it.
        assert.strictEqual(span.parent_id.toString(10), '0')
        assert.strictEqual(span.metrics['_dd.top_level'], 1)
        assert.strictEqual(span.metrics._sampling_priority_v1, USER_KEEP)
        assert.strictEqual(span.metrics.process_id, process.pid)
        assert.strictEqual(span.meta.language, 'javascript')
        assert.strictEqual(span.meta['_dd.p.dm'], `-${SAMPLING_MECHANISM_AI_GUARD}`)
        assert.match(span.meta['_dd.tags.process'], /entrypoint\.name:/)
        assert.match(span.meta['runtime-id'], /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/)
        for (const key of [
          '_dd.top_level',
          '_dd.rule_psr',
          '_dd1.sr.eausr',
          '_dd.custom',
          '_sampling_priority_v1',
          'process_id',
        ]) {
          assert.ok(!Object.hasOwn(span.meta, key), `Unexpected tag ${key}`)
        }
        for (const key of ['_dd.rule_psr', '_dd1.sr.eausr', '_dd.custom']) {
          assert.ok(!Object.hasOwn(span.metrics, key), `Unexpected metric ${key}`)
        }
        assert.strictEqual(span.meta['dd.custom'], 'kept')
      })
    })

    it('does not add ai_guard.redacted when the redaction kill-switch is off', async () => {
      const disabled = new AIGuard(tracer, {
        ...config,
        aiguard: { ...config.aiguard, DD_AI_GUARD_REDACTION_ENABLED: false },
      })
      mockExtra({ tags: kv({ 'ai_guard.redacted': 'false', 'ai_guard.policy_name': 'default' }) })

      const result = await disabled.evaluate(messages)

      assert.strictEqual(result.action, 'ALLOW')
      await assertSpan(span => {
        assert.ok(!Object.hasOwn(span.meta, 'ai_guard.redacted'))
        assert.strictEqual(span.meta['ai_guard.policy_name'], 'default')
      })
    })

    it('applies extra tags and meta-struct values on the blocking path', async () => {
      const policyDetails = { rule: 'no-recursive-delete' }
      mockExtra({
        tags: kv({ 'ai_guard.policy_name': 'destructive-actions', 'ai_guard.evaluate_id': evaluateId }),
        metastruct: kv({ policy_details: policyDetails }),
        attributes: { action: 'DENY', reason: 'Nope', tags: ['destructive'], is_blocking_enabled: true },
      })

      await rejects(
        () => aiguard.evaluate(messages, { block: true }),
        err => err.name === 'AIGuardAbortError' && err.reason === 'Nope'
      )

      assertTelemetry('requests', { action: 'DENY', error: false, block: true, ...sdkTags })
      await assertSpan((span, metaStruct) => {
        assert.strictEqual(span.meta['ai_guard.action'], 'DENY')
        assert.strictEqual(span.meta['ai_guard.blocked'], 'true')
        assert.strictEqual(span.meta['ai_guard.policy_name'], 'destructive-actions')
        assert.strictEqual(span.meta['ai_guard.evaluate_id'], evaluateId)
        assert.deepStrictEqual(metaStruct, {
          messages,
          attack_categories: ['destructive'],
          policy_details: policyDetails,
        })
      })
    })

    for (const field of fields) {
      for (const payload of [
        { 'ai_guard.policy_name': 'newsroom-default' },
        'ai_guard.policy_name=newsroom-default',
        42,
        true,
        null,
        [],
        undefined,
      ]) {
        it(`ignores ${field} ${inspect(payload)} without changing the evaluation`, async () => {
          mockExtra({
            tags: field === 'extra_tags' ? payload : undefined,
            metastruct: field === 'extra_metastruct' ? payload : undefined,
            attributes: { reason: 'ok' },
          })

          const result = await aiguard.evaluate(messages)

          assertEvaluationUnchanged(result)
          await assertSpan((span, metaStruct) => {
            assert.strictEqual(span.error, 0)
            assert.deepStrictEqual(
              Object.keys(span.meta).filter(key => key.startsWith('ai_guard.')).sort(),
              ['ai_guard.action', 'ai_guard.event', 'ai_guard.reason', 'ai_guard.redacted', 'ai_guard.target']
            )
            assert.deepStrictEqual(metaStruct, { messages })
          })
        })
      }

      it(`skips malformed ${field} entries and keeps the valid ones`, async () => {
        const entries = [
          'ai_guard.policy_name',
          42,
          null,
          ['ai_guard.policy_name', 'forged'],
          { value: 'missing key' },
          { key: '', value: 'empty key' },
          { key: 1, value: 'number key' },
          { key: '__proto__', value: { polluted: 'true' } },
          { key: 'valid', value: 'kept' },
        ]
        mockExtra({
          tags: field === 'extra_tags' ? entries : undefined,
          metastruct: field === 'extra_metastruct' ? entries : undefined,
          attributes: { reason: 'ok' },
        })

        const result = await aiguard.evaluate(messages)

        assertEvaluationUnchanged(result)
        await assertSpan((span, metaStruct) => {
          assert.strictEqual(span.error, 0)
          for (const key of ['', '1']) {
            assert.ok(!Object.hasOwn(span.meta, key), `Unexpected tag ${key}`)
          }
          if (field === 'extra_tags') {
            assert.strictEqual(span.meta.valid, 'kept')
            assert.deepStrictEqual(metaStruct, { messages })
          } else {
            assert.ok(!Object.hasOwn(span.meta, 'valid'))
            assert.deepStrictEqual(metaStruct, { messages, valid: 'kept' })
          }
        })
      })
    }
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
