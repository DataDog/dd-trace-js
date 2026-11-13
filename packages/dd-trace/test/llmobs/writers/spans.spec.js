'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const telemetryMetrics = require('../../../src/telemetry/metrics')

const { removeDestroyHandler } = require('../util')

describe('LLMObsSpanWriter', () => {
  let LLMObsSpanWriter
  let writer
  let config
  let logger

  beforeEach(() => {
    logger = {
      warn: sinon.stub(),
      debug: sinon.stub(),
    }
    LLMObsSpanWriter = proxyquire('../../../src/llmobs/writers/spans', {
      '../../log': logger,
    })
    config = {
      url: new URL('http://localhost:8126'),
      site: 'datadoghq.com',
    }
  })

  afterEach(() => {
    removeDestroyHandler()
  })

  it('is initialized correctly', () => {
    writer = new LLMObsSpanWriter(config)

    assert.strictEqual(writer._eventType, 'span')
  })

  for (const [name, meta, expected] of [
    ['flat', { 'span.kind': 'llm' }, 'llm'],
    ['nested', { span: { kind: 'workflow' } }, 'workflow'],
    ['missing', {}, ''],
  ]) {
    it(`reports the ${name} span kind in writer size telemetry`, () => {
      const distribution = sinon.spy(telemetryMetrics.manager.namespace('mlobs'), 'distribution')
      writer = new LLMObsSpanWriter(config)
      try {
        writer.append({ name: 'test', meta })
        for (const metric of ['span.raw_size', 'span.size']) {
          const calls = distribution.getCalls().filter(call => call.args[0] === metric)
          assert.equal(calls.length, 1)
          assert.equal(calls[0].args[1].span_kind, expected)
        }
        assert.deepEqual(writer.makePayload(writer._buffer.events)[0].spans[0].meta, meta)
      } finally {
        distribution.restore()
      }
    })
  }

  it('creates an agentless writer', () => {
    writer = new LLMObsSpanWriter(config)
    writer.setAgentless(true)
    assert.strictEqual(writer._agentless, true)
    assert.strictEqual(writer.url, 'https://llmobs-intake.datadoghq.com/api/v2/llmobs')
  })

  it('creates an agent proxy writer', () => {
    writer = new LLMObsSpanWriter(config)
    writer.setAgentless(false)

    assert.strictEqual(writer._agentless, false)
    assert.strictEqual(writer.url, 'http://localhost:8126/evp_proxy/v2/api/v2/llmobs')
  })

  it('computes the number of bytes of the appended event', () => {
    writer = new LLMObsSpanWriter(config)

    const event = { name: 'test', value: 1 }
    const eventSizeBytes = Buffer.byteLength(JSON.stringify(event))

    writer.append(event)

    assert.strictEqual(writer._buffer.size, eventSizeBytes)
  })

  it('truncates the event if it exceeds the size limit', () => {
    writer = new LLMObsSpanWriter(config)

    const event = {
      name: 'test',
      meta: {
        input: { value: 'a'.repeat(3 * 1024 * 1024) },
        output: { value: 'a'.repeat(3 * 1024 * 1024) },
      },
    }

    writer.append(event)

    const bufferEvent = writer._buffer.events[0]
    assert.deepStrictEqual(bufferEvent, {
      name: 'test',
      meta: {
        input: { value: "[This value has been dropped because this span's size exceeds the 5MB size limit.]" },
        output: { value: "[This value has been dropped because this span's size exceeds the 5MB size limit.]" },
      },
      collection_errors: ['dropped_io'],
    })
  })

  it('flushes the queue if the next event will exceed the payload limit', () => {
    writer = new LLMObsSpanWriter(config)
    writer.flush = sinon.stub()

    writer._buffer.size = (5 << 20) - 1
    writer._buffer.events = Array.from({ length: 10 })
    const event = { name: 'test', value: 'a'.repeat(1024) }

    writer.append(event)

    sinon.assert.calledOnce(writer.flush)
    sinon.assert.calledWith(logger.debug,
      'Flushing queue because queuing next event will exceed EvP payload limit'
    )
  })

  it('creates the payload correctly', () => {
    writer = new LLMObsSpanWriter(config)

    const events = [
      { name: 'test', value: 1 },
    ]

    const payload = writer.makePayload(events)

    assert.strictEqual(payload[0]['_dd.stage'], 'raw')
    assert.strictEqual(payload[0].event_type, 'span')
    assert.deepStrictEqual(payload[0].spans, events)
  })

  it('marks experiment-scoped payload envelopes', () => {
    writer = new LLMObsSpanWriter(config)

    const events = [
      { name: 'experiment-row', _dd: { scope: 'experiments' } },
    ]

    const payload = writer.makePayload(events)

    assert.strictEqual(payload[0]['_dd.scope'], 'experiments')
    assert.deepStrictEqual(payload[0].spans, events)
  })
})
