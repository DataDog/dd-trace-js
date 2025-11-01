'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, context } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../setup/core')

const URL = require('url').URL

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

  beforeEach((done) => {
    span = 'formatted'

    response = JSON.stringify({
      rate_by_service: {
        'service:hello,env:test': 1
      }
    })

    request = sinon.stub().yieldsAsync(null, response, 200)

    encoder = {
      encode: sinon.stub(),
      count: sinon.stub().returns(0),
      makePayload: sinon.stub().returns([])
    }

    url = new URL('http://localhost:8126')

    prioritySampler = {
      update: sinon.spy()
    }

    log = {
      error: sinon.spy(),
      errorWithoutTelemetry: sinon.spy(),
      debug: sinon.spy()
    }

    const AgentEncoder = function () {
      return encoder
    }

    Writer = proxyquire('../../../src/exporters/agent/writer', {
      '../common/request': request,
      '../../encode/0.4': { AgentEncoder },
      '../../encode/0.5': { AgentEncoder },
      '../../../../../package.json': { version: 'tracerVersion' },
      '../../log': log
    })

    // Use shorter backoff times for testing
    const config = {
      initialBackoff: 50,  // 50ms instead of 1s
      maxBackoff: 500      // 500ms instead of 30s
    }
    writer = new Writer({ url, prioritySampler, protocolVersion, config })

    process.nextTick(done)
  })

  describe('append', () => {
    it('should append a trace', () => {
      writer.append([span])

      expect(encoder.encode).to.have.been.calledWith([span])
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
      expect(request.getCall(0).args[1]).to.contain({
        url
      })
    })
  })

  describe('flush', () => {
    it('should skip flushing if empty', () => {
      writer.flush()

      expect(encoder.makePayload).to.not.have.been.called
    })

    it('should empty the internal queue', () => {
      encoder.count.returns(1)

      writer.flush()

      expect(encoder.makePayload).to.have.been.called
    })

    it('should call callback when empty', (done) => {
      writer.flush(done)
    })

    it('should flush its traces to the agent, and call callback', (done) => {
      const expectedData = Buffer.from('prefixed')

      encoder.count.returns(2)
      encoder.makePayload.returns([expectedData])
      writer.flush(() => {
        expect(request.getCall(0).args[0]).to.eql([expectedData])
        expect(request.getCall(0).args[1]).to.eql({
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
            'Datadog-Send-Real-Http-Status': 'true'
          },
          lookup: undefined
        })
        done()
      })
    })

    it('should pass through headers', (done) => {
      const headers = {
        'My-Header': 'bar'
      }
      writer = new Writer({ url, prioritySampler, protocolVersion, headers })
      encoder.count.returns(2)
      encoder.makePayload.returns([Buffer.from('data')])
      writer.flush(() => {
        expect(request.getCall(0).args[1].headers).to.eql({
          ...headers,
          'Content-Type': 'application/msgpack',
          'Datadog-Meta-Lang': 'nodejs',
          'Datadog-Meta-Lang-Version': process.version,
          'Datadog-Meta-Lang-Interpreter': 'v8',
          'Datadog-Meta-Tracer-Version': 'tracerVersion',
          'X-Datadog-Trace-Count': '2',
          'Datadog-Send-Real-Http-Status': 'true'
        })
        done()
      })
    })

    it('should include Datadog-Send-Real-Http-Status header', (done) => {
      encoder.count.returns(1)
      encoder.makePayload.returns([Buffer.from('data')])
      writer.flush(() => {
        expect(request.getCall(0).args[1].headers).to.have.property('Datadog-Send-Real-Http-Status', 'true')
        done()
      })
    })

    it('should log request errors', done => {
      const error = new Error('boom')
      error.status = 42

      request.yields(error)

      encoder.count.returns(1)
      writer.flush(() => {
        expect(log.errorWithoutTelemetry)
          .to.have.been.calledWith('Error sending payload to the agent (status code: %s)',
            error.status, error)
        done()
      })
    })

    it('should update sampling rates', (done) => {
      encoder.count.returns(1)
      writer.flush(() => {
        expect(prioritySampler.update).to.have.been.calledWith({
          'service:hello,env:test': 1
        })
        done()
      })
    })

    it('should queue payload for retry on 429 response', (done) => {
      request.yieldsAsync(new Error('Too Many Requests'), null, 429)

      encoder.count.returns(1)
      encoder.makePayload.returns([Buffer.from('data')])

      writer.flush(() => {
        // First request should have been made
        expect(request).to.have.been.calledOnce
        // Retry process should be in progress
        expect(writer._retryInProgress).to.equal(true)
        // Check queue before setTimeout processes it
        setTimeout(() => {
          // The item should still be in queue waiting for backoff timeout
          expect(writer._retryQueue).to.have.lengthOf(1)
          done()
        }, 100)
      })
    })

    it('should not queue payload for retry on non-429 errors', (done) => {
      const error = new Error('Server Error')
      error.status = 500
      request.yieldsAsync(error, null, 500)

      encoder.count.returns(1)
      encoder.makePayload.returns([Buffer.from('data')])

      writer.flush(() => {
        expect(request).to.have.been.calledOnce
        // Should not queue non-429 errors
        expect(writer._retryQueue).to.have.lengthOf(0)
        done()
      })
    })

    it('should not queue if retry queue is at max capacity', (done) => {
      request.yieldsAsync(new Error('Too Many Requests'), null, 429)

      // Fill the retry queue to max capacity
      writer._retryQueue = new Array(1000).fill({ data: [Buffer.from('old')], count: 1 })

      encoder.count.returns(1)
      encoder.makePayload.returns([Buffer.from('data')])

      writer.flush(() => {
        // Queue should still be at max
        expect(writer._retryQueue).to.have.lengthOf(1000)
        done()
      })
    })

    it('should retry queued payloads with exponential backoff', (done) => {
      // First call returns 429, second call succeeds
      request.onFirstCall().yieldsAsync(new Error('Too Many Requests'), null, 429)
      request.onSecondCall().yieldsAsync(null, response, 200)

      encoder.count.returns(1)
      encoder.makePayload.returns([Buffer.from('data')])

      writer.flush(() => {
        // After first flush, should have queued the payload
        // The retry process starts automatically
        expect(writer._retryInProgress).to.equal(true)

        // Wait for retry to complete (initial backoff is 50ms in tests)
        setTimeout(() => {
          expect(request).to.have.been.calledTwice
          expect(writer._retryInProgress).to.equal(false)
          done()
        }, 150)
      })
    })

    it('should reset backoff after successful retry', (done) => {
      // First two calls return 429, third succeeds
      request.onCall(0).yieldsAsync(new Error('Too Many Requests'), null, 429)
      request.onCall(1).yieldsAsync(new Error('Too Many Requests'), null, 429)
      request.onCall(2).yieldsAsync(null, response, 200)

      encoder.count.returns(1)
      encoder.makePayload.returns([Buffer.from('data')])

      writer.flush(() => {
        // Wait for retries to complete
        // Backoffs: 50ms, 100ms
        setTimeout(() => {
          // After success, backoff should be reset to 50ms
          expect(writer._currentBackoff).to.equal(50)
          expect(request).to.have.been.calledThrice
          done()
        }, 250)
      })
    })

    it('should enforce maximum backoff time', (done) => {
      // Simulate multiple failures to test max backoff
      // Calls 0-4 return 429, call 5 succeeds
      for (let i = 0; i < 5; i++) {
        request.onCall(i).yieldsAsync(new Error('Too Many Requests'), null, 429)
      }
      request.onCall(5).yieldsAsync(null, response, 200)

      encoder.count.returns(1)
      encoder.makePayload.returns([Buffer.from('data')])

      writer.flush(() => {
        // After multiple 429s, backoff should cap at 500ms (test max)
        // Backoffs: 50ms, 100ms, 200ms, 400ms, 500ms (capped)
        setTimeout(() => {
          // Backoff should not exceed maximum (500ms in tests)
          expect(writer._currentBackoff).to.be.at.most(500)
          done()
        }, 2000)
      })
    })

    context('with the url as a unix socket', () => {
      beforeEach(() => {
        url = new URL('unix:/path/to/somesocket.sock')
        const config = {
          initialBackoff: 50,
          maxBackoff: 500
        }
        writer = new Writer({ url, protocolVersion, config })
      })

      it('should make a request to the socket', () => {
        encoder.count.returns(1)
        writer.flush()
        setImmediate(() => {
          expect(request.getCall(0).args[1]).to.contain({
            url
          })
        })
      })
    })
  })
}

describe('Writer', () => {
  describe('0.4', () => describeWriter(0.4))

  describe('0.5', () => describeWriter(0.5))
})
