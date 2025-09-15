'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const { useEnv } = require('../../../../../integration-tests/helpers')

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
      '../../log': logger,
      './util': proxyquire('../../../src/llmobs/writers/util', {
        '../../log': logger
      })
    })

    clock = sinon.useFakeTimers()

    options = {
      endpoint: '/endpoint',
      intake: 'intake',
      config: {
        site: 'site.com',
        hostname: 'localhost',
        port: 8126,
        apiKey: 'test'
      }
    }
  })

  afterEach(() => {
    clock.restore()
    process.removeAllListeners('beforeExit')
  })

  it('constructs an agentless writer', () => {
    writer = new BaseLLMObsWriter(options)
    writer.setAgentless(true)

    expect(writer._agentless).to.be.true
    expect(writer.url).to.equal('https://intake.site.com/endpoint')
  })

  it('constructs an agent proxy writer', () => {
    writer = new BaseLLMObsWriter(options)
    writer.setAgentless(false)

    expect(writer._agentless).to.be.false
    expect(writer.url).to.equal('http://localhost:8126/evp_proxy/v2/endpoint')
  })

  describe('with override origin', () => {
    useEnv({
      _DD_LLMOBS_OVERRIDE_ORIGIN: 'http://override-origin:12345'
    })

    it('constructs a writer with the correct url', () => {
      writer = new BaseLLMObsWriter(options)
      writer.setAgentless(false)

      expect(writer.url).to.equal('http://override-origin:12345/evp_proxy/v2/endpoint')
    })
  })

  describe('with config url', () => {
    beforeEach(() => {
      options.config.url = new URL('http://test-agent:12345')
    })

    afterEach(() => {
      delete options.config.url
    })

    it('constructs a writer with a custom url', () => {
      writer = new BaseLLMObsWriter(options)
      writer.setAgentless(false)

      expect(writer.url).to.equal('http://test-agent:12345/evp_proxy/v2/endpoint')
    })
  })

  describe('with unix socket', () => {
    beforeEach(() => {
      options.config.url = new URL('unix:///var/run/datadog/apm.socket/')
    })

    afterEach(() => {
      delete options.config.url
    })

    it('constructs a writer with the correct url', () => {
      writer = new BaseLLMObsWriter(options)
      writer.setAgentless(false)

      expect(writer.url).to.equal('unix:///var/run/datadog/apm.socket/evp_proxy/v2/endpoint')
    })

    it('makes the request with the correct options', () => {
      writer = new BaseLLMObsWriter(options)
      writer.setAgentless(false)
      writer.makePayload = (events) => ({ events })

      writer.append({ foo: 'bar' })
      writer.flush()

      const requestOptions = request.getCall(0).args[1]
      expect(requestOptions.url.href).to.equal('unix:///var/run/datadog/apm.socket/')
      expect(requestOptions.path).to.equal('/evp_proxy/v2/endpoint')
    })
  })

  it('calls flush before the process exits', () => {
    writer = new BaseLLMObsWriter(options)
    writer.setAgentless(true)
    writer.flush = sinon.spy()

    process.emit('beforeExit')

    expect(writer.flush).to.have.been.calledOnce
  })

  it('flushes when an uncaught exception is thrown', () => {})

  it('calls flush at the correct interval', async () => {
    writer = new BaseLLMObsWriter(options)
    writer.setAgentless(true)

    writer.flush = sinon.spy()

    clock.tick(1000)

    expect(writer.flush).to.have.been.calledOnce
  })

  it('appends an event to the buffer', () => {
    writer = new BaseLLMObsWriter(options)
    writer.setAgentless(true)
    const event = { foo: 'bar–' }
    writer.append(event)

    expect(writer._buffer).to.have.lengthOf(1)
    expect(writer._buffer[0]).to.deep.equal(event)
    expect(writer._bufferSize).to.equal(16)
  })

  it('does not append an event if the buffer is full', () => {
    writer = new BaseLLMObsWriter(options)
    writer.setAgentless(true)

    for (let i = 0; i < 1000; i++) {
      writer.append({ foo: 'bar' })
    }

    writer.append({ foo: 'bar' })
    expect(writer._buffer).to.have.lengthOf(1000)
    expect(logger.warn).to.have.been.calledWith('BaseLLMObsWriter event buffer full (limit is 1000), dropping event')
  })

  describe('flush', () => {
    it('flushes a buffer in agentless mode', () => {
      writer = new BaseLLMObsWriter(options)
      writer.setAgentless(true)
      writer.makePayload = (events) => ({ events })

      writer.append({ foo: 'bar' })
      writer.flush()

      const requestOptions = request.getCall(0).args[1]
      expect(requestOptions.url.href).to.equal('https://intake.site.com/')
      expect(requestOptions.path).to.equal('/endpoint')
      expect(requestOptions.headers['Content-Type']).to.equal('application/json')
      expect(requestOptions.headers['DD-API-KEY']).to.equal('test')
    })

    it('flushes a buffer in agent proxy mode', () => {
      writer = new BaseLLMObsWriter(options)
      writer.setAgentless(false)
      writer.makePayload = (events) => ({ events })

      writer.append({ foo: 'bar' })
      writer.flush()

      const requestOptions = request.getCall(0).args[1]
      expect(requestOptions.url.href).to.equal('http://localhost:8126/')
      expect(requestOptions.path).to.equal('/evp_proxy/v2/endpoint')
      expect(requestOptions.headers['Content-Type']).to.equal('application/json')
      expect(requestOptions.headers['X-Datadog-EVP-Subdomain']).to.equal('intake')
    })

    it('does not flush when agentless property is not set', () => {
      writer = new BaseLLMObsWriter(options)
      writer.makePayload = (events) => ({ events })

      const event = { foo: 'bar' }
      writer.append(event)
      writer.flush()

      expect(request).to.not.have.been.called
      expect(writer._buffer).to.have.lengthOf(1)
      expect(writer._buffer[0]).to.deep.equal(event)

      writer.setAgentless(true)
      writer.flush()

      expect(request).to.have.been.calledOnce
    })
  })

  it('does not flush an empty buffer', () => {
    writer = new BaseLLMObsWriter(options)
    writer.setAgentless(true)
    writer.flush()

    expect(request).to.not.have.been.called
  })

  it('logs errors from the request', () => {
    writer = new BaseLLMObsWriter(options)
    writer.setAgentless(true)
    writer.makePayload = (events) => ({ events })

    writer.append({ foo: 'bar' })

    const error = new Error('boom')
    request.callsFake((url, options, callback) => {
      callback(error)
    })

    writer.flush()

    expect(logger.error).to.have.been.calledWith(
      'Error sending %d LLMObs %s events to %s: %s', 1, undefined, 'https://intake.site.com/endpoint', 'boom', error
    )
  })

  describe('destroy', () => {
    it('destroys the writer', () => {
      sinon.spy(global, 'clearInterval')
      sinon.spy(process, 'removeListener')
      writer = new BaseLLMObsWriter(options)
      writer.setAgentless(true)
      writer.flush = sinon.stub()

      writer.destroy()

      expect(writer._destroyed).to.be.true
      expect(clearInterval).to.have.been.calledWith(writer._periodic)
      expect(process.removeListener).to.have.been.calledWith('beforeExit', writer._beforeExitHandler)
      expect(writer.flush).to.have.been.calledOnce
      expect(logger.debug)
        .to.have.been.calledWith('Stopping BaseLLMObsWriter')
    })

    it('does not destroy more than once', () => {
      writer = new BaseLLMObsWriter(options)
      writer.setAgentless(true)

      logger.debug.reset() // ignore log from constructor
      writer.destroy()
      writer.destroy()

      expect(logger.debug).to.have.been.calledOnce
    })
  })
})
