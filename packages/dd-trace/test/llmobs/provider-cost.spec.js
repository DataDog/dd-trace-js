'use strict'

const assert = require('node:assert/strict')
const { before, describe, it } = require('mocha')
const sinon = require('sinon')
const SpanWriter = require('../../src/llmobs/writers/spans')
const { storage } = require('../../src/llmobs/storage')
const { buildConversationCostEvent } = require('../../src/llmobs/provider-cost')
const NoopLLMObs = require('../../src/llmobs/noop')
const { useLlmObs } = require('./util')
const cases = require('./fixtures/elevenlabs-conversation-costs.json')
const golden = require('./fixtures/elevenlabs-conversation-cost.json')

/** @param {object} wire */
function sdkResponse (wire) {
  const response = JSON.parse(JSON.stringify(wire))
  const metadata = response.metadata
  response.conversationId = response.conversation_id
  delete response.conversation_id
  for (const [snake, camel] of [
    ['start_time_unix_secs', 'startTimeUnixSecs'],
    ['call_duration_secs', 'callDurationSecs'],
    ['cost_fiat', 'costFiat'],
  ]) {
    metadata[camel] = metadata[snake]
    delete metadata[snake]
  }
  if (metadata.charging) {
    metadata.charging.llmPrice = metadata.charging.llm_price
    metadata.charging.platformPrice = metadata.charging.platform_price
    delete metadata.charging.llm_price
    delete metadata.charging.platform_price
  }
  return response
}

describe('conversation billing normalization', () => {
  for (const fixture of cases) {
    for (const shape of ['wire', 'sdk']) {
      it(`${fixture.name} (${shape})`, () => {
        const response = shape === 'wire' ? structuredClone(fixture.response) : sdkResponse(fixture.response)
        const before = structuredClone(response)
        const event = buildConversationCostEvent(response, { mlApp: 'test', totalCost: fixture.total_cost })
        assert.equal(Boolean(event), fixture.valid)
        if (event) {
          assert.deepEqual(event.meta.metadata.provider_cost.owner, golden.owner)
          assert.equal(event.meta.metadata.provider_cost.provider, 'elevenlabs')
          assert.equal(event.meta.metadata.provider_cost.currency, 'USD')
          assert.equal(event.meta.span.kind, 'workflow')
          assert.equal(event.meta.metadata.ttfa_eligible, false)
          assert.deepEqual(event.metrics, fixture.total_cost == null ? {} : { total_cost: fixture.total_cost })
          assert.equal(event.meta.input, undefined)
          assert.equal(event.meta.output, undefined)
          assert.equal(event.meta.model_provider, undefined)
        }
        assert.deepEqual(response, before)
      })
    }
  }

  it('matches the shared billing contract exactly', () => {
    const event = buildConversationCostEvent(cases[0].response, { mlApp: 'test' })
    assert.ok(event)
    assert.deepEqual(event.meta.metadata.provider_cost, golden)
  })

  it('preserves explicit override zero and rejects invalid amounts', () => {
    const response = structuredClone(cases[0].response)
    const event = buildConversationCostEvent(response, { mlApp: 'test', totalCost: 0 })
    assert.ok(event)
    assert.deepEqual(event.metrics, { total_cost: 0 })
    for (const amount of [NaN, Infinity, -Infinity, -1, true]) {
      response.metadata.cost_fiat = amount
      assert.equal(buildConversationCostEvent(response, { mlApp: 'test' }), undefined)
    }
  })

  it('keeps the same owner for late billing and both delivery sources', () => {
    const partialFixture = cases.find(fixture => fixture.name === 'partial_llm')
    assert.ok(partialFixture)
    const partial = partialFixture.response
    const first = buildConversationCostEvent(partial, { mlApp: 'test' })
    const second = buildConversationCostEvent(cases[0].response, { mlApp: 'test', source: 'post_call_transcription' })
    assert.ok(first)
    assert.ok(second)
    assert.deepEqual(first.meta.metadata.provider_cost.owner, second.meta.metadata.provider_cost.owner)
    assert.equal(first.meta.metadata.provider_cost.amounts.total, undefined)
    assert.equal(second.meta.metadata.provider_cost.provenance.total.kind, 'post_call_transcription')
  })

  it('exposes a disabled no-op', () => {
    assert.equal(new NoopLLMObs({}).submitConversationCost(cases[0].response), false)
  })
})

describe('conversation billing SDK emission', () => {
  const { getEvents } = useLlmObs()
  let llmobs
  before(() => { llmobs = global._ddtrace.llmobs })

  it('emits an explicit billing observation without an APM request span', async () => {
    const response = sdkResponse(cases[0].response)
    assert.equal(llmobs.submitConversationCost(response), true)
    const { apmSpans, llmobsSpans } = await getEvents(1, { writerOnly: true })
    assert.equal(apmSpans.length, 0)
    assert.equal(llmobsSpans.length, 1)
    assert.deepEqual(llmobsSpans[0].meta.metadata.provider_cost, golden)
    assert.deepEqual(llmobsSpans[0].metrics, {})
    assert.deepEqual(llmobsSpans[0].meta.span, { kind: 'workflow' })
  })

  it('queues an explicit zero total override', async () => {
    const response = structuredClone(cases[0].response)
    response.conversation_id = 'conv-zero-override'
    assert.equal(llmobs.submitConversationCost(response, { totalCost: 0 }), true)
    const { llmobsSpans } = await getEvents(1, { writerOnly: true })
    assert.deepEqual(llmobsSpans[0].metrics, { total_cost: 0 })
  })

  it('keeps caller tenant routing on the billing observation', () => {
    const routing = { apiKey: 'test-routed-key', site: 'datad0g.com' }
    const append = sinon.stub(SpanWriter.prototype, 'append').returns(true)
    try {
      storage.run({ routingContext: routing }, () => {
        assert.equal(llmobs.submitConversationCost(cases[0].response), true)
      })
      assert.equal(append.callCount, 1)
      assert.deepEqual(append.firstCall.args[1], routing)
    } finally {
      append.restore()
    }
  })

  it('returns false without affecting the application when the local writer rejects', () => {
    const append = sinon.stub(SpanWriter.prototype, 'append').throws(new Error('writer rejected billing'))
    try {
      assert.equal(llmobs.submitConversationCost(cases[0].response), false)
    } finally {
      append.restore()
    }
  })

  for (const [name, routing] of [
    ['default', undefined],
    ['tenant', { apiKey: 'billing-capacity-key', site: 'datad0g.com' }],
  ]) {
    it(`accepts the last available ${name} buffer slot and rejects the next observation`, () => {
      const append = sinon.spy(SpanWriter.prototype, 'append')
      const submit = () => storage.run({ routingContext: routing }, () => {
        return llmobs.submitConversationCost(cases[0].response)
      })
      let buffer
      try {
        assert.equal(submit(), true)
        buffer = append.firstCall.thisValue._getBuffer(routing)
        buffer.clear()
        for (let index = 0; index < 999; index++) assert.equal(submit(), true)
        assert.equal(buffer.events.length, 999)
        assert.equal(submit(), true)
        assert.equal(buffer.events.length, 1000)
        assert.equal(submit(), false)
        assert.equal(buffer.events.length, 1000)
      } finally {
        buffer?.clear()
        append.restore()
      }
    })
  }

  it('submits duplicate sources with stable IDs', async () => {
    assert.equal(llmobs.submitConversationCost(cases[0].response), true)
    assert.equal(llmobs.submitConversationCost(cases[0].response, {
      source: 'post_call_transcription',
    }), true)
    const { llmobsSpans } = await getEvents(2, { writerOnly: true })
    assert.equal(llmobsSpans[0].trace_id, llmobsSpans[1].trace_id)
    assert.equal(llmobsSpans[0].span_id, llmobsSpans[1].span_id)
    assert.deepEqual(llmobsSpans[1].metrics, {})
  })
})

describe('conversation billing application selection', () => {
  const { getEvents } = useLlmObs({
    tracerConfigOptions: { service: 'voice-agent', llmobs: { agentlessEnabled: false } },
  })

  it('uses the service name when no application is configured', async () => {
    const llmobs = global._ddtrace.llmobs
    assert.equal(llmobs.enabled, true)
    assert.equal(llmobs.submitConversationCost(cases[0].response), true)
    const { llmobsSpans } = await getEvents(1, { writerOnly: true })
    assert.ok(llmobsSpans[0].tags.includes('ml_app:voice-agent'))
  })

  it('prefers an explicit application over the service name', async () => {
    assert.equal(global._ddtrace.llmobs.submitConversationCost(cases[0].response, { mlApp: 'explicit-app' }), true)
    const { llmobsSpans } = await getEvents(1, { writerOnly: true })
    assert.ok(llmobsSpans[0].tags.includes('ml_app:explicit-app'))
  })
})
