'use strict'

const proxyquire = require('proxyquire')

describe('LLMObsSpanWriter', () => {
  let LLMObsSpanWriter
  let writer
  let options
  let logger

  beforeEach(() => {
    logger = {
      warn: sinon.stub(),
      debug: sinon.stub()
    }
    LLMObsSpanWriter = proxyquire('../../../../src/llmobs/writers/spans/base', {
      '../../../log': logger
    })
    options = {
      endpoint: '/api/v2/llmobs',
      intake: 'llmobs-intake.datadoghq.com'
    }
  })

  afterEach(() => {
    process.removeAllListeners('beforeExit')
  })

  it('is initialized correctly', () => {
    writer = new LLMObsSpanWriter(options)

    expect(writer._eventType).to.equal('span')
  })

  it('computes the number of bytes of the appended event', () => {
    writer = new LLMObsSpanWriter(options)

    const event = { name: 'test', value: 1 }
    const eventSizeBytes = Buffer.from(JSON.stringify(event)).byteLength

    writer.append(event)

    expect(writer._bufferSize).to.equal(eventSizeBytes)
  })

  it('truncates the event if it exceeds the size limit', () => {
    writer = new LLMObsSpanWriter(options)

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
    writer = new LLMObsSpanWriter(options)
    writer.flush = sinon.stub()

    writer._bufferSize = (5 << 20) - 1
    writer._buffer = Array.from({ length: 10 })
    const event = { name: 'test', value: 'a'.repeat(1024) }

    writer.append(event)

    expect(writer.flush).to.have.been.calledOnce
    expect(logger.debug).to.have.been.calledWith(
      'Flusing queue because queing next event will exceed EvP payload limit'
    )
  })

  it('creates the payload correctly', () => {
    writer = new LLMObsSpanWriter(options)

    const events = [
      { name: 'test', value: 1 }
    ]

    const payload = writer.makePayload(events)

    expect(payload['_dd.stage']).to.equal('raw')
    expect(payload.event_type).to.equal('span')
    expect(payload.spans).to.deep.equal(events)
  })
})
