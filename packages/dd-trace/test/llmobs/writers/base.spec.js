'use strict'
const { expect } = require('chai')
const proxyquire = require('proxyquire')

describe('BaseLLMObsWriter', () => {
  let BaseLLMObsWriter
  let writer
  let request
  let clock
  let options
  let logger

  beforeEach(() => {
    request = sinon.stub()
    logger = {
      debug: sinon.stub(),
      warn: sinon.stub(),
      error: sinon.stub()
    }
    BaseLLMObsWriter = proxyquire('../../../src/llmobs/writers/base', {
      '../../exporters/common/request': request,
      '../../log': logger
    })

    clock = sinon.useFakeTimers()

    options = {
      endpoint: '/api/v2/llmobs',
      intake: 'llmobs-intake.datadoghq.com'
    }
  })

  afterEach(() => {
    clock.restore()
    process.removeAllListeners('beforeExit')
  })

  it('constructs a writer with a url', () => {
    writer = new BaseLLMObsWriter(options)

    expect(writer._url.href).to.equal('https://llmobs-intake.datadoghq.com/api/v2/llmobs')
    expect(logger.debug).to.have.been.calledWith(
      'Started BaseLLMObsWriter to https://llmobs-intake.datadoghq.com/api/v2/llmobs'
    )
  })

  it('calls flush before the process exits', () => {
    writer = new BaseLLMObsWriter(options)
    writer.flush = sinon.spy()

    process.emit('beforeExit')

    expect(writer.flush).to.have.been.calledOnce
  })

  it('calls flush at the correct interval', async () => {
    writer = new BaseLLMObsWriter(options)

    writer.flush = sinon.spy()

    clock.tick(1000)

    expect(writer.flush).to.have.been.calledOnce
  })

  it('appends an event to the buffer', () => {
    writer = new BaseLLMObsWriter(options)
    const event = { foo: 'bar–' }
    writer.append(event)

    expect(writer._buffer).to.have.lengthOf(1)
    expect(writer._buffer[0]).to.deep.equal(event)
    expect(writer._bufferSize).to.equal(16)
  })

  it('does not append an event if the buffer is full', () => {
    writer = new BaseLLMObsWriter(options)

    for (let i = 0; i < 1000; i++) {
      writer.append({ foo: 'bar' })
    }

    writer.append({ foo: 'bar' })
    expect(writer._buffer).to.have.lengthOf(1000)
    expect(logger.warn).to.have.been.calledWith('BaseLLMObsWriter event buffer full (limit is 1000), dropping event')
  })

  it('flushes the buffer', () => {
    writer = new BaseLLMObsWriter(options)

    const event1 = { foo: 'bar' }
    const event2 = { foo: 'baz' }

    writer.append(event1)
    writer.append(event2)

    writer.makePayload = (events) => ({ events })

    // Stub the request function to call its third argument
    request.callsFake((url, options, callback) => {
      callback(null, null, 202)
    })

    writer.flush()

    expect(request).to.have.been.calledOnce
    const calledArgs = request.getCall(0).args

    expect(calledArgs[0]).to.deep.equal(JSON.stringify({ events: [event1, event2] }))
    expect(calledArgs[1]).to.deep.equal({
      headers: {
        'Content-Type': 'application/json'
      },
      method: 'POST',
      url: writer._url,
      timeout: 5000
    })

    expect(logger.debug).to.have.been.calledWith(
      'Sent 2 LLMObs undefined events to https://llmobs-intake.datadoghq.com/api/v2/llmobs'
    )

    expect(writer._buffer).to.have.lengthOf(0)
    expect(writer._bufferSize).to.equal(0)
  })

  it('does not flush an empty buffer', () => {
    writer = new BaseLLMObsWriter(options)
    writer.flush()

    expect(request).to.not.have.been.called
  })

  it('logs errors from the request', () => {
    writer = new BaseLLMObsWriter(options)
    writer.makePayload = (events) => ({ events })

    writer.append({ foo: 'bar' })

    const error = new Error('boom')
    let reqUrl
    request.callsFake((url, options, callback) => {
      reqUrl = options.url
      callback(error)
    })

    writer.flush()

    expect(logger.error).to.have.been.calledWith(
      'Error sending %d LLMObs %s events to %s: %s', 1, undefined, reqUrl, 'boom', error
    )
  })

  describe('destroy', () => {
    it('destroys the writer', () => {
      sinon.spy(global, 'clearInterval')
      sinon.spy(process, 'removeListener')
      writer = new BaseLLMObsWriter(options)
      writer.flush = sinon.stub()

      writer.destroy()

      expect(writer._destroyed).to.be.true
      expect(clearInterval).to.have.been.calledWith(writer._periodic)
      expect(process.removeListener).to.have.been.calledWith('beforeExit', writer.destroy)
      expect(writer.flush).to.have.been.calledOnce
      expect(logger.debug)
        .to.have.been.calledWith('Stopping BaseLLMObsWriter')
    })

    it('does not destroy more than once', () => {
      writer = new BaseLLMObsWriter(options)

      logger.debug.reset() // ignore log from constructor
      writer.destroy()
      writer.destroy()

      expect(logger.debug).to.have.been.calledOnce
    })
  })
})
