'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

describe('LLMObsSpanWriter', () => {
  let LLMObsSpanWriter
  let writer
  let config
  let logger

  beforeEach(() => {
    logger = {
      warn: sinon.stub(),
      debug: sinon.stub()
    }
    LLMObsSpanWriter = proxyquire('../../../src/llmobs/writers/spans', {
      '../../log': logger
    })
    config = {
      port: 8126,
      hostname: 'localhost',
      site: 'datadoghq.com'
    }
  })

  afterEach(() => {
    process.removeAllListeners('beforeExit')
  })

  it('is initialized correctly', () => {
    writer = new LLMObsSpanWriter(config)

    expect(writer._eventType).to.equal('span')
  })

  it('creates an agentless writer', () => {
    writer = new LLMObsSpanWriter(config)
    writer.setAgentless(true)
    expect(writer._agentless).to.equal(true)
    expect(writer.url).to.equal('https://llmobs-intake.datadoghq.com/api/v2/llmobs')
  })

  it('creates an agent proxy writer', () => {
    writer = new LLMObsSpanWriter(config)
    writer.setAgentless(false)

    expect(writer._agentless).to.equal(false)
    expect(writer.url).to.equal('http://localhost:8126/evp_proxy/v2/api/v2/llmobs')
  })

  it('computes the number of bytes of the appended event', () => {
    writer = new LLMObsSpanWriter(config)

    const event = { name: 'test', value: 1 }
    const eventSizeBytes = Buffer.byteLength(JSON.stringify(event))

    writer.append(event)

    expect(writer._bufferSize).to.equal(eventSizeBytes)
  })

  it('truncates the event if it exceeds the size limit', () => {
    writer = new LLMObsSpanWriter(config)

    const event = {
      name: 'test',
      meta: {
        input: { value: 'a'.repeat(1024 * 1024) },
        output: { value: 'a'.repeat(1024 * 1024) }
      }
    }

    writer.append(event)

    const bufferEvent = writer._buffer[0]
    expect(bufferEvent).to.deep.equal({
      name: 'test',
      meta: {
        input: { value: "[This value has been dropped because this span's size exceeds the 1MB size limit.]" },
        output: { value: "[This value has been dropped because this span's size exceeds the 1MB size limit.]" }
      },
      collection_errors: ['dropped_io']
    })
  })

  it('flushes the queue if the next event will exceed the payload limit', () => {
    writer = new LLMObsSpanWriter(config)
    writer.flush = sinon.stub()

    writer._bufferSize = (5 << 20) - 1
    writer._buffer = Array.from({ length: 10 })
    const event = { name: 'test', value: 'a'.repeat(1024) }

    writer.append(event)

    expect(writer.flush).to.have.been.calledOnce
    expect(logger.debug).to.have.been.calledWith(
      'Flushing queue because queuing next event will exceed EvP payload limit'
    )
  })

  it('creates the payload correctly', () => {
    writer = new LLMObsSpanWriter(config)

    const events = [
      { name: 'test', value: 1 }
    ]

    const payload = writer.makePayload(events)

    expect(payload[0]['_dd.stage']).to.equal('raw')
    expect(payload[0].event_type).to.equal('span')
    expect(payload[0].spans).to.deep.equal(events)
  })
})
