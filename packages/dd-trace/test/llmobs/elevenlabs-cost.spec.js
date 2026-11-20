'use strict'

const assert = require('node:assert/strict')
const { channel } = require('dc-polyfill')
const { beforeEach, afterEach, describe, it } = require('mocha')
const sinon = require('sinon')
const { collectConversationCost } = require('../../src/llmobs/elevenlabs-cost')

const append = channel('llmobs:provider-cost:append')
const config = { llmobs: { DD_LLMOBS_ML_APP: 'test' }, env: 'test' }
/** @returns {object} */
const completed = () => ({
  conversation_id: 'conv-test',
  status: 'done',
  metadata: {
    start_time_unix_secs: 1000,
    call_duration_secs: 10,
    cost_fiat: 0.12,
    charging: { llm_price: 0.02, platform_price: 0.1 },
  },
})

describe('ElevenLabs automatic billing', () => {
  let clock, client, get, enabled, events, listener
  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: 1000000 })
    get = sinon.stub().resolves(completed())
    client = { conversationalAi: { conversations: { get } } }
    enabled = true
    events = []
    listener = submission => { events.push(submission); submission.submitted = true }
    append.subscribe(listener)
  })
  afterEach(async () => {
    enabled = false
    await clock.tickAsync(40000)
    append.unsubscribe(listener)
    clock.restore()
  })
  function start (id = 'conv-test', routing) {
    collectConversationCost(client, id, config, routing, () => enabled)
  }

  it('preserves USD components, routing and owner without token estimates', async () => {
    const routing = { targets: [] }
    start('conv-test', routing)
    assert.equal(get.callCount, 0)
    await clock.tickAsync(1000)
    assert.equal(get.callCount, 1)
    assert.equal(events.length, 1)
    assert.equal(events[0].routing, routing)
    assert.deepEqual(events[0].event.meta.metadata.provider_cost.amounts, { total: 0.12, llm: 0.02, platform: 0.1 })
    assert.deepEqual(events[0].event.metrics, {})
    assert.equal(get.firstCall.args[0], 'conv-test')
    assert.equal(get.firstCall.args[2].maxRetries, 0)
    assert.equal(get.firstCall.args[2].timeoutInSeconds, 3)
  })
  it('retries processing and enriches partial costs including zero', async () => {
    const partial = completed()
    partial.metadata.cost_fiat = 0
    partial.metadata.charging = undefined
    const full = completed()
    full.metadata.cost_fiat = full.metadata.charging.llm_price = full.metadata.charging.platform_price = 0
    get.onFirstCall().resolves({ conversation_id: 'conv-test', status: 'processing' })
    get.onSecondCall().resolves(partial)
    get.onThirdCall().resolves(full)
    start()
    await clock.tickAsync(7000)
    assert.equal(get.callCount, 3)
    assert.equal(events.length, 2)
    assert.equal(events[0].event.meta.metadata.provider_cost.amounts.total, 0)
    assert.equal(events[0].event.span_id, events[1].event.span_id)
  })
  it('deduplicates concurrent delivery', async () => {
    start(); start()
    await clock.tickAsync(40000)
    assert.equal(get.callCount, 1)
    assert.equal(events.length, 1)
  })
  for (const statusCode of [401, 403, 404]) {
    it(`stops on HTTP ${statusCode} without leaking errors`, async () => {
      get.rejects({ statusCode })
      start()
      await clock.tickAsync(40000)
      assert.equal(get.callCount, 1)
      assert.equal(events.length, 0)
    })
  }
  for (const statusCode of [429, 500]) {
    it(`retries HTTP ${statusCode} within five attempts`, async () => {
      get.rejects({ statusCode })
      start()
      await clock.tickAsync(40000)
      assert.equal(get.callCount, 5)
      assert.equal(events.length, 0)
    })
  }
  it('retains capacity until timed-out underlying requests settle', async () => {
    const pending = []
    get.callsFake(() => new Promise(resolve => pending.push(resolve)))
    try {
      for (let n = 0; n < 20; n++) start(`conv-${n}`)
      await clock.tickAsync(40000)
      assert.equal(get.callCount, 8)
      assert.ok(get.getCalls().every(call => call.args[2].abortSignal.aborted))
      clock.setSystemTime(Date.now() - 60000)
      for (let n = 20; n < 40; n++) start(`conv-${n}`)
      await clock.tickAsync(40000)
      assert.equal(get.callCount, 8)
      assert.equal(events.length, 0)
    } finally {
      for (const resolve of pending) resolve(completed())
      await clock.tickAsync(0)
    }
    get.resolves(completed())
    start()
    await clock.tickAsync(1000)
    assert.equal(get.callCount, 9)
    assert.equal(events.length, 1)
  })
  it('retries a request only after cancellation has settled it', async () => {
    get.callsFake((id, unused, options) => new Promise((resolve, reject) => {
      options.abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    start()
    await clock.tickAsync(40000)
    assert.ok(get.callCount > 1)
    assert.ok(get.callCount <= 5)
    assert.equal(events.length, 0)
  })
  it('skips work disabled before lookup or after a pending request', async () => {
    start()
    enabled = false
    await clock.tickAsync(40000)
    assert.equal(get.callCount, 0)
    enabled = true
    get.callsFake(async () => { enabled = false; return completed() })
    start()
    await clock.tickAsync(40000)
    assert.equal(events.length, 0)
  })
  for (const amount of [-1, Infinity, NaN]) {
    it(`rejects invalid cost ${amount}`, async () => {
      const response = completed()
      response.metadata.cost_fiat = amount
      get.resolves(response)
      start()
      await clock.tickAsync(40000)
      assert.equal(events.length, 0)
    })
  }
  it('does not submit a mismatched conversation', async () => {
    const response = completed()
    response.conversation_id = 'other'
    get.resolves(response)
    start()
    await clock.tickAsync(40000)
    assert.equal(events.length, 0)
    assert.equal(get.callCount, 1)
  })
  it('caps active collections and releases capacity after completion', async () => {
    for (let n = 0; n < 20; n++) start(`conv-${n}`)
    await clock.tickAsync(40000)
    assert.equal(get.callCount, 8)
    start()
    await clock.tickAsync(1000)
    assert.equal(events.length, 1)
  })
  it('leaves retry timers unreferenced', () => {
    const unref = sinon.spy(global, 'setTimeout')
    try {
      start()
      assert.equal(unref.firstCall.returnValue.hasRef(), false)
    } finally { unref.restore() }
  })
})
