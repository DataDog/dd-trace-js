'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')
const { useEnv } = require('../../../../../integration-tests/helpers')
const { removeDestroyHandler } = require('../util')

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
      error: sinon.stub(),
    }
    BaseLLMObsWriter = proxyquire('../../../src/llmobs/writers/base', {
      '../../exporters/common/request': request,
      '../../log': logger,
      './util': proxyquire('../../../src/llmobs/writers/util', {
        '../../log': logger,
      }),
    })

    clock = sinon.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })

    options = {
      endpoint: '/endpoint',
      intake: 'intake',
      config: {
        site: 'site.com',
        url: new URL('http://localhost:8126'),
        apiKey: 'test',
      },
    }
  })

  afterEach(() => {
    clock.restore()
    removeDestroyHandler()
  })

  it('constructs an agentless writer', () => {
    writer = new BaseLLMObsWriter(options)
    writer.setAgentless(true)

    assert.strictEqual(writer._agentless, true)
    assert.strictEqual(writer.url, 'https://intake.site.com/endpoint')
  })

  it('constructs an agent proxy writer', () => {
    writer = new BaseLLMObsWriter(options)
    writer.setAgentless(false)

    assert.strictEqual(writer._agentless, false)
    assert.strictEqual(writer.url, 'http://localhost:8126/evp_proxy/v2/endpoint')
  })

  describe('with override origin', () => {
    useEnv({
      _DD_LLMOBS_OVERRIDE_ORIGIN: 'http://override-origin:12345',
    })

    it('constructs a writer with the correct url', () => {
      writer = new BaseLLMObsWriter(options)
      writer.setAgentless(false)

      assert.strictEqual(writer.url, 'http://override-origin:12345/evp_proxy/v2/endpoint')
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

      assert.strictEqual(writer.url, 'http://test-agent:12345/evp_proxy/v2/endpoint')
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

      assert.strictEqual(writer.url, 'unix:///var/run/datadog/apm.socket/evp_proxy/v2/endpoint')
    })

    it('makes the request with the correct options', () => {
      writer = new BaseLLMObsWriter(options)
      writer.setAgentless(false)
      writer.makePayload = (events) => ({ events })

      writer.append({ foo: 'bar' })
      writer.flush()

      const requestOptions = request.getCall(0).args[1]
      assert.strictEqual(requestOptions.url.href, 'unix:///var/run/datadog/apm.socket/')
      assert.strictEqual(requestOptions.path, '/evp_proxy/v2/endpoint')
    })
  })

  it('calls flush before the process exits', () => {
    writer = new BaseLLMObsWriter(options)
    writer.setAgentless(true)
    writer.flush = sinon.spy()

    process.emit('beforeExit')

    sinon.assert.calledOnce(writer.flush)
  })

  it('flushes when an uncaught exception is thrown', () => {})

  it('calls flush at the correct interval', async () => {
    writer = new BaseLLMObsWriter(options)
    writer.setAgentless(true)

    writer.flush = sinon.spy()

    clock.tick(1000)

    sinon.assert.calledOnce(writer.flush)
  })

  it('appends an event to the buffer', () => {
    writer = new BaseLLMObsWriter(options)
    writer.setAgentless(true)
    const event = { foo: 'bar–' }
    writer.append(event)

    assert.strictEqual(writer._buffer.events.length, 1)
    assert.deepStrictEqual(writer._buffer.events[0], event)
    assert.strictEqual(writer._buffer.size, 16)
  })

  it('does not append an event if the buffer is full', () => {
    writer = new BaseLLMObsWriter(options)
    writer.setAgentless(true)

    for (let i = 0; i < 1000; i++) {
      writer.append({ foo: 'bar' })
    }

    writer.append({ foo: 'bar' })
    assert.strictEqual(writer._buffer.events.length, 1000)
    sinon.assert.calledWith(logger.warn, 'BaseLLMObsWriter event buffer full (limit is 1000), dropping event')
  })

  describe('flush', () => {
    it('flushes a buffer in agentless mode', () => {
      writer = new BaseLLMObsWriter(options)
      writer.setAgentless(true)
      writer.makePayload = (events) => ({ events })

      writer.append({ foo: 'bar' })
      writer.flush()

      const requestOptions = request.getCall(0).args[1]
      assert.strictEqual(requestOptions.url.href, 'https://intake.site.com/')
      assert.strictEqual(requestOptions.path, '/endpoint')
      assert.strictEqual(requestOptions.headers['Content-Type'], 'application/json')
      assert.strictEqual(requestOptions.headers['DD-API-KEY'], 'test')
    })

    it('flushes a buffer in agent proxy mode', () => {
      writer = new BaseLLMObsWriter(options)
      writer.setAgentless(false)
      writer.makePayload = (events) => ({ events })

      writer.append({ foo: 'bar' })
      writer.flush()

      const requestOptions = request.getCall(0).args[1]
      assert.strictEqual(requestOptions.url.href, 'http://localhost:8126/')
      assert.strictEqual(requestOptions.path, '/evp_proxy/v2/endpoint')
      assert.strictEqual(requestOptions.headers['Content-Type'], 'application/json')
      assert.strictEqual(requestOptions.headers['X-Datadog-EVP-Subdomain'], 'intake')
    })

    it('flushes routed buffers directly to intake in agent proxy mode', () => {
      writer = new BaseLLMObsWriter(options)
      writer.setAgentless(false)
      writer.makePayload = (events) => ({ events })

      writer.append({ foo: 'bar' }, { apiKey: 'key-a', site: 'site-a.com' })
      writer.flush()

      const requestOptions = request.getCall(0).args[1]
      assert.strictEqual(requestOptions.url.href, 'https://intake.site-a.com/')
      assert.strictEqual(requestOptions.path, '/endpoint')
      assert.strictEqual(requestOptions.headers['DD-API-KEY'], 'key-a')
    })

    it('does not flush when agentless property is not set', () => {
      writer = new BaseLLMObsWriter(options)
      writer.makePayload = (events) => ({ events })

      const event = { foo: 'bar' }
      writer.append(event)
      writer.flush()

      sinon.assert.notCalled(request)
      assert.strictEqual(writer._buffer.events.length, 1)
      assert.deepStrictEqual(writer._buffer.events[0], event)

      writer.setAgentless(true)
      writer.flush()

      sinon.assert.calledOnce(request)
    })
  })

  it('does not flush an empty buffer', () => {
    writer = new BaseLLMObsWriter(options)
    writer.setAgentless(true)
    writer.flush()

    sinon.assert.notCalled(request)
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

    sinon.assert.calledWith(logger.error,
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
      // Call twice to ensure it sets the state properly
      writer.destroy()

      sinon.assert.calledWith(clearInterval, writer._periodic)
      sinon.assert.calledOnce(writer.flush)
      sinon.assert.calledWith(logger.debug, 'Stopping BaseLLMObsWriter')

      for (const handler of globalThis[Symbol.for('dd-trace')].beforeExitHandlers) {
        if (handler.name.endsWith('destroy')) {
          assert.fail('destroy handler should not be present')
        }
      }
    })

    it('does not destroy more than once', () => {
      writer = new BaseLLMObsWriter(options)
      writer.setAgentless(true)

      logger.debug.reset() // ignore log from constructor
      writer.destroy()
      writer.destroy()

      sinon.assert.calledOnce(logger.debug)
    })
  })
})
