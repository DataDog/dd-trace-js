'use strict'

const assert = require('node:assert/strict')

const { before, describe, it } = require('mocha')
const sinon = require('sinon')

const tracerVersion = require('../../../../package.json').version
const { storage } = require('../../../datadog-core')
const agent = require('../plugins/agent')
const { useLlmObs } = require('./util')

describe('LLMObs test event collection', () => {
  const { getEvents, assertNoLlmObsSpans } = useLlmObs()
  let tracer

  before(() => { tracer = global._ddtrace })

  /**
   * @param {string} name
   * @param {{ plain?: boolean, writerFallback?: boolean }} [options]
   */
  async function emitChunk (name, { plain = false, writerFallback = false } = {}) {
    const received = agent.assertSomeTraces(traces => {
      assert.ok(traces.flat().some(span => span.name === name))
    })
    try {
      if (plain) tracer.trace(name, () => {})
      else {
        tracer.llmobs.trace({ kind: 'task', name }, span => {
          if (writerFallback) {
            tracer.llmobs.annotate(span, { tags: { 'collector.route': 'one', collector_route: 'two' } })
          }
        })
      }
      tracer.llmobs.flush()
      await received
    } finally {
      received.cancel()
    }
  }

  async function collectWriterCompletedRead () {
    const collecting = getEvents()
    const deliver = async () => {
      await emitChunk('plain-before-writer', { plain: true })
      const event = {
        trace_id: '1',
        span_id: '1',
        parent_id: 'undefined',
        name: 'writer-only',
        start_ns: Math.round(Date.now() * 1e6),
        duration: 1,
        status: 'ok',
        meta: { 'span.kind': 'task', input: {}, output: {} },
        metrics: {},
        tags: ['ml_app:test'],
      }
      const payload = [{ '_dd.stage': 'raw', '_dd.tracer_version': tracerVersion, event_type: 'span', spans: [event] }]
      await storage('legacy').run({ noop: true }, async () => {
        const response = await fetch(`http://127.0.0.1:${agent.port}/evp_proxy/v2/api/v2/llmobs`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        })
        assert.strictEqual(response.status, 200)
        await response.text()
      })
    }
    const [result] = await Promise.all([collecting, deliver()])
    return result
  }

  it('keeps a completed mixed-route read from consuming the next APM batch', async () => {
    const first = await collectWriterCompletedRead()
    assert.deepStrictEqual(first.llmobsSpans.map(span => span.name), ['writer-only'])
    const [second] = await Promise.all([getEvents(), emitChunk('next-apm')])
    assert.deepStrictEqual(second.llmobsSpans.map(span => span.name), ['next-apm'])
    assert.deepStrictEqual(first.llmobsSpans.map(span => span.name), ['writer-only'])
  })

  it('keeps forbidden APM events visible after a writer-completed read', async () => {
    await collectWriterCompletedRead()
    const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    try {
      await Promise.all([
        assert.rejects(assertNoLlmObsSpans(), /expected no LLMObs spans/),
        emitChunk('forbidden-after-writer'),
      ])
    } finally {
      clock.restore()
    }
  })

  it('retains every APM chunk received before getEvents starts', async () => {
    await emitChunk('first')
    await emitChunk('second')
    const { apmSpans, llmobsSpans } = await getEvents(2)
    assert.deepStrictEqual(llmobsSpans.map(span => span.name).sort(), ['first', 'second'])
    assert.strictEqual(apmSpans.length, 2)
    assert.ok(apmSpans.every(span => span.meta_struct?._llmobs))
  })

  it('combines queued APM and legacy-writer events', async () => {
    await emitChunk('apm-first')
    await emitChunk('writer', { writerFallback: true })
    await emitChunk('apm-last')
    const { apmSpans, llmobsSpans } = await getEvents(3)
    assert.deepStrictEqual(llmobsSpans.map(span => span.name).sort(), ['apm-first', 'apm-last', 'writer'])
    const writerSpan = apmSpans.find(span => span.name === 'writer')
    assert.strictEqual(writerSpan.meta_struct?._llmobs, undefined)
    assert.strictEqual(writerSpan.meta['_dd.llmobs.submitted'], '1')
  })

  it('does not repeat a drained APM batch in the next collection', async () => {
    await emitChunk('earlier')
    const first = await getEvents()
    assert.deepStrictEqual(first.llmobsSpans.map(span => span.name), ['earlier'])
    await emitChunk('later')
    const second = await getEvents()
    assert.deepStrictEqual(second.llmobsSpans.map(span => span.name), ['later'])
    assert.strictEqual(second.apmSpans.length, 1)
  })

  it('detects a forbidden LLMObs event in a later APM chunk', async () => {
    await emitChunk('plain-apm', { plain: true })
    const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    try {
      await Promise.all([
        assert.rejects(assertNoLlmObsSpans(), /expected no LLMObs spans/),
        emitChunk('forbidden'),
      ])
    } finally {
      clock.restore()
    }
  })
})
