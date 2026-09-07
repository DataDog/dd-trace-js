'use strict'

const assert = require('node:assert/strict')
const URL = require('url').URL

const { describe, it, beforeEach } = require('mocha')
const context = describe
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const { channel } = require('dc-polyfill')

const { assertObjectContains } = require('../../../../../integration-tests/helpers')
require('../../setup/core')

function describeWriter (protocolVersion) {
  let Writer
  let writer
  let span
  let request
  let response
  let encoder
  let url
  let prioritySampler
  let log
  let AgentEncoder
  let createAgentEncoder

  beforeEach((done) => {
    span = 'formatted'

    response = JSON.stringify({
      rate_by_service: {
        'service:hello,env:test': 1,
      },
    })

    request = sinon.stub().yieldsAsync(null, response, 200)

    encoder = {
      encode: sinon.stub(),
      count: sinon.stub().returns(0),
      makePayload: sinon.stub().returns([]),
    }

    url = new URL('http://localhost:8126')

    prioritySampler = {
      update: sinon.spy(),
    }

    log = {
      error: sinon.spy(),
      errorWithoutTelemetry: sinon.spy(),
    }

    AgentEncoder = sinon.stub().returns(encoder)
    createAgentEncoder = sinon.stub().returns(encoder)

    Writer = proxyquire('../../../src/exporters/agent/writer', {
      '../common/request': request,
      '../../ci-visibility/exporters/request': request,
      '../../encode/0.4': { AgentEncoder },
      '../../encode/0.4-cross-payload': { createAgentEncoder },
      '../../encode/0.5': { AgentEncoder },
      '../../../../../package.json': { version: 'tracerVersion' },
      '../../log': log,
    })
    writer = new Writer({ url, prioritySampler, protocolVersion })

    process.nextTick(done)
  })

  if (protocolVersion === '0.4') {
    it('should use the cross-payload encoder for a zero flush interval', () => {
      AgentEncoder.resetHistory()
      createAgentEncoder.resetHistory()

      writer = new Writer({ url, prioritySampler, protocolVersion, flushInterval: 0 })

      sinon.assert.calledOnceWithExactly(createAgentEncoder, writer, sinon.match.func)
      sinon.assert.notCalled(AgentEncoder)
    })

    it('should switch to the regular encoder when cross-payload caching is disabled', () => {
      AgentEncoder.resetHistory()
      createAgentEncoder.resetHistory()

      writer = new Writer({ url, prioritySampler, protocolVersion, flushInterval: 0 })
      const disableCrossPayloadCache = createAgentEncoder.firstCall.args[1]
      disableCrossPayloadCache()

      sinon.assert.calledOnceWithExactly(AgentEncoder, writer)
      assert.strictEqual(writer._encoder, encoder)
    })

    it('should keep the regular encoder for a nonzero flush interval', () => {
      AgentEncoder.resetHistory()
      createAgentEncoder.resetHistory()

      writer = new Writer({ url, prioritySampler, protocolVersion, flushInterval: 2000 })

      sinon.assert.notCalled(createAgentEncoder)
      sinon.assert.calledOnceWithExactly(AgentEncoder, writer)
    })
  } else {
    it('should keep the 0.5 encoder independent of the flush interval', () => {
      AgentEncoder.resetHistory()
      createAgentEncoder.resetHistory()

      writer = new Writer({ url, prioritySampler, protocolVersion, flushInterval: 0 })

      sinon.assert.notCalled(createAgentEncoder)
      sinon.assert.calledOnceWithExactly(AgentEncoder, writer)
    })
  }

  describe('append', () => {
    it('should append a trace', () => {
      writer.append([span])

      sinon.assert.calledWith(encoder.encode, [span])
    })
  })

  describe('setUrl', () => {
    it('should set the URL used in the flush', () => {
      const url = new URL('http://example.com:1234')
      writer.setUrl(url)
      writer.append([span])
      encoder.count.returns(2)
      encoder.makePayload.returns([Buffer.alloc(0)])
      writer.flush()
      assertObjectContains(request.getCall(0).args[1], {
        url,
      })
    })
  })

  describe('flush', () => {
    it('should skip flushing if empty', () => {
      writer.flush()

      sinon.assert.notCalled(encoder.makePayload)
    })

    it('should empty the internal queue', () => {
      encoder.count.returns(1)

      writer.flush()

      sinon.assert.called(encoder.makePayload)
    })

    it('should call callback when empty', (done) => {
      writer.flush(done)
    })

    it('routes flushes through the configured delivery tracker', (done) => {
      const deliveryTracker = { track: sinon.spy((flush, done) => flush(done)) }
      writer = new Writer({ url, prioritySampler, protocolVersion, deliveryTracker })

      writer.flush(() => {
        try {
          sinon.assert.calledOnce(deliveryTracker.track)
          done()
        } catch (error) {
          done(error)
        }
      })
    })

    it('should flush its traces to the agent, and call callback', (done) => {
      const expectedData = Buffer.from('prefixed')

      encoder.count.returns(2)
      encoder.makePayload.returns([expectedData])
      writer.flush(() => {
        assert.deepStrictEqual(request.getCall(0).args[0], [expectedData])
        assert.deepStrictEqual(request.getCall(0).args[1], {
          url,
          path: `/v${protocolVersion}/traces`,
          method: 'PUT',
          headers: {
            'Content-Type': 'application/msgpack',
            'Datadog-Meta-Lang': 'nodejs',
            'Datadog-Meta-Lang-Version': process.version,
            'Datadog-Meta-Lang-Interpreter': 'v8',
            'Datadog-Meta-Tracer-Version': 'tracerVersion',
            'X-Datadog-Trace-Count': '2',
          },
          lookup: undefined,
        })
        done()
      })
    })

    it('should pass through headers', (done) => {
      const headers = {
        'My-Header': 'bar',
      }
      writer = new Writer({ url, prioritySampler, protocolVersion, headers })
      encoder.count.returns(2)
      encoder.makePayload.returns([Buffer.from('data')])
      writer.flush(() => {
        assert.deepStrictEqual(request.getCall(0).args[1].headers, {
          ...headers,
          'Content-Type': 'application/msgpack',
          'Datadog-Meta-Lang': 'nodejs',
          'Datadog-Meta-Lang-Version': process.version,
          'Datadog-Meta-Lang-Interpreter': 'v8',
          'Datadog-Meta-Tracer-Version': 'tracerVersion',
          'X-Datadog-Trace-Count': '2',
        })
        done()
      })
    })

    it('should log request errors', done => {
      const error = new Error('boom')
      error.status = 42

      request.yields(error)

      encoder.count.returns(1)
      writer.flush()

      setTimeout(() => {
        sinon.assert.calledWith(
          log.errorWithoutTelemetry,
          'Error sending payload to the agent (status code: %s)',
          error.status,
          error
        )
        done()
      })
    })

    it('should propagate terminal errors during a bounded Test Optimization flush', (done) => {
      const error = new Error('agent unavailable')
      const deadline = Date.now() + 10_000
      request.yieldsAsync(error, null, 503)
      encoder.count.returns(1)
      writer = new Writer({ url, prioritySampler, protocolVersion, isTestOptimization: true })

      writer.flush((flushError) => {
        assert.strictEqual(flushError, error)
        assert.strictEqual(request.firstCall.args[1].deadline, deadline)
        done()
      }, { deadline })
    })

    it('should wait for Test Optimization requests already in flight during a bounded final flush', () => {
      request.resetBehavior()
      writer = new Writer({ url, prioritySampler, protocolVersion, isTestOptimization: true })
      encoder.count.onFirstCall().returns(1).returns(0)
      writer.flush()

      const done = sinon.spy()
      const deadline = Date.now() + 10_000
      writer.flush(done, { deadline })

      sinon.assert.notCalled(done)
      assert.strictEqual(request.firstCall.args[1].deadline, deadline)
      request.firstCall.args[2](null, response, 200)
      sinon.assert.calledOnceWithExactly(done, undefined)
    })

    it('should update sampling rates', (done) => {
      encoder.count.returns(1)
      writer.flush(() => {
        sinon.assert.calledWith(prioritySampler.update, {
          'service:hello,env:test': 1,
        })
        done()
      })
    })

    it('should publish event on first flush with data', () => {
      const ch = channel('dd-trace:exporter:first-flush')
      let published = false
      const onFirstFlush = () => { published = !published }
      ch.subscribe(onFirstFlush)

      encoder.count.returns(1)
      writer.flush()

      assert.strictEqual(published, true)
      writer.flush()
      // should only publish on first flush, hence published should mantain as true
      assert.strictEqual(published, true)
      ch.unsubscribe(onFirstFlush)
    })

    context('with the url as a unix socket', () => {
      beforeEach(() => {
        url = new URL('unix:/path/to/somesocket.sock')
        writer = new Writer({ url, protocolVersion })
      })

      it('should make a request to the socket', () => {
        encoder.count.returns(1)
        writer.flush()
        setImmediate(() => {
          assertObjectContains(request.getCall(0).args[1], {
            url,
          })
        })
      })
    })
  })
}

describe('Writer', () => {
  it('enables backpressure retention only for Test Optimization', () => {
    const writerOptions = []
    class BaseWriter {
      constructor (options) {
        writerOptions.push(options)
      }
    }
    class AgentEncoder {}
    const Writer = proxyquire('../../../src/exporters/agent/writer', {
      '../common/writer': BaseWriter,
      '../../encode/0.4': { AgentEncoder },
    })

    const regularWriter = new Writer({ protocolVersion: '0.4' })
    const testOptimizationWriter = new Writer({ protocolVersion: '0.4', isTestOptimization: true })

    assert.ok(regularWriter instanceof Writer)
    assert.ok(testOptimizationWriter instanceof Writer)
    assert.strictEqual(writerOptions[0].retainOnBackpressure, undefined)
    assert.strictEqual(writerOptions[1].retainOnBackpressure, true)
  })

  describe('0.4', () => describeWriter('0.4'))

  describe('0.5', () => describeWriter('0.5'))
})
