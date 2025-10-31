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
      errorWithoutTelemetry: sinon.spy()
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
    writer = new Writer({ url, prioritySampler, protocolVersion })

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
      encoder.count.returns(2)
      encoder.makePayload.returns([Buffer.from('data')])
      writer.flush(() => {
        expect(request.getCall(0).args[1].headers['Datadog-Send-Real-Http-Status']).to.equal('true')
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

    context('with the url as a unix socket', () => {
      beforeEach(() => {
        url = new URL('unix:/path/to/somesocket.sock')
        writer = new Writer({ url, protocolVersion })
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

    context('with 429 (rate limit) responses', () => {
      let clock

      beforeEach(() => {
        clock = sinon.useFakeTimers()
      })

      afterEach(() => {
        clock.restore()
      })

      it('should retry on 429 response with exponential backoff', (done) => {
        encoder.count.returns(2)
        encoder.makePayload.returns([Buffer.from('data')])

        let callCount = 0
        request.callsFake((data, options, callback) => {
          callCount++
          if (callCount < 3) {
            // First two calls return 429
            callback(null, null, 429)
          } else {
            // Third call succeeds
            callback(null, response, 200)
          }
        })

        writer.flush(() => {
          expect(callCount).to.equal(3)
          done()
        })

        // Fast-forward through retry delays
        clock.tick(1000) // First retry after 1s
        clock.tick(2000) // Second retry after 2s
      })

      it('should drop payload after max retry attempts', (done) => {
        encoder.count.returns(2)
        encoder.makePayload.returns([Buffer.from('data')])

        // Always return 429
        request.yields(null, null, 429)

        writer.flush(() => {
          // Should have attempted 4 times total (initial + 3 retries)
          expect(request.callCount).to.equal(4)
          expect(log.errorWithoutTelemetry).to.have.been.calledWith(
            'Maximum retry attempts reached for 429 response, dropping payload'
          )
          done()
        })

        // Fast-forward through all retry delays
        clock.tick(1000) // First retry
        clock.tick(2000) // Second retry
        clock.tick(4000) // Third retry
      })

      it('should handle multiple concurrent 429 responses', (done) => {
        encoder.count.returns(2)
        encoder.makePayload.returns([Buffer.from('data')])

        let callCount = 0
        request.callsFake((data, options, callback) => {
          callCount++
          if (callCount <= 5) {
            // First 5 calls return 429
            callback(null, null, 429)
          } else {
            // Subsequent calls succeed
            callback(null, response, 200)
          }
        })

        let completed = 0
        const total = 3

        for (let i = 0; i < total; i++) {
          writer.flush(() => {
            completed++
            if (completed === total) {
              // All flushes should complete
              expect(completed).to.equal(total)
              done()
            }
          })
        }

        // Fast-forward through retry delays
        for (let i = 0; i < 10; i++) {
          clock.tick(1000)
        }
      })

      it('should drop payloads when retry queue is full', (done) => {
        const config = { maxRetryQueueSize: 5 }
        writer = new Writer({ url, prioritySampler, protocolVersion, config })

        encoder.count.returns(2)
        encoder.makePayload.returns([Buffer.from('data')])

        // Always return 429
        request.yields(null, null, 429)

        let completed = 0
        const total = 10 // More than maxRetryQueueSize

        for (let i = 0; i < total; i++) {
          writer.flush(() => {
            completed++
            if (completed === total) {
              // Should have dropped some payloads
              expect(log.errorWithoutTelemetry).to.have.been.calledWith(
                'Retry queue is full, dropping payload'
              )
              done()
            }
          })
        }

        // Fast-forward to process initial requests
        clock.tick(100)
      })

      it('should call done callback only once per flush', (done) => {
        encoder.count.returns(2)
        encoder.makePayload.returns([Buffer.from('data')])

        let callCount = 0
        request.callsFake((data, options, callback) => {
          callCount++
          if (callCount === 1) {
            callback(null, null, 429)
          } else {
            callback(null, response, 200)
          }
        })

        let doneCallCount = 0
        writer.flush(() => {
          doneCallCount++
          // Should only be called once even though retry happened
          expect(doneCallCount).to.equal(1)
          done()
        })

        clock.tick(1000) // First retry
      })

      it('should handle errors during retry processing', (done) => {
        encoder.count.returns(2)
        encoder.makePayload.returns([Buffer.from('data')])

        let callCount = 0
        request.callsFake((data, options, callback) => {
          callCount++
          if (callCount === 1) {
            callback(null, null, 429)
          } else if (callCount === 2) {
            // Simulate synchronous error during retry
            throw new Error('Retry processing error')
          } else {
            callback(null, response, 200)
          }
        })

        writer.flush(() => {
          expect(log.errorWithoutTelemetry).to.have.been.calledWith(
            'Error processing retry',
            sinon.match.instanceOf(Error)
          )
          done()
        })

        clock.tick(1000) // First retry (will throw)
      })

      it('should use configurable retry parameters', (done) => {
        const config = {
          maxRetryAttempts: 2,
          baseRetryDelay: 500,
          maxRetryQueueSize: 50
        }
        writer = new Writer({ url, prioritySampler, protocolVersion, config })

        encoder.count.returns(2)
        encoder.makePayload.returns([Buffer.from('data')])

        // Always return 429
        request.yields(null, null, 429)

        writer.flush(() => {
          // Should have attempted 3 times total (initial + 2 retries)
          expect(request.callCount).to.equal(3)
          done()
        })

        // Fast-forward using custom delay
        clock.tick(500) // First retry
        clock.tick(1000) // Second retry
      })

      it('should properly schedule retries with correct timing', (done) => {
        encoder.count.returns(2)
        encoder.makePayload.returns([Buffer.from('data')])

        const retryTimes = []
        let callCount = 0

        request.callsFake((data, options, callback) => {
          callCount++
          retryTimes.push(Date.now())

          if (callCount < 4) {
            callback(null, null, 429)
          } else {
            callback(null, response, 200)
          }
        })

        writer.flush(() => {
          // Verify exponential backoff timing: initial, +1s, +2s, +4s
          expect(retryTimes[1] - retryTimes[0]).to.equal(1000) // First retry
          expect(retryTimes[2] - retryTimes[1]).to.equal(2000) // Second retry
          expect(retryTimes[3] - retryTimes[2]).to.equal(4000) // Third retry
          done()
        })

        clock.tick(1000) // First retry
        clock.tick(2000) // Second retry
        clock.tick(4000) // Third retry
      })
    })

    context('cleanup and shutdown', () => {
      it('should clean up pending retries on destroy', (done) => {
        encoder.count.returns(2)
        encoder.makePayload.returns([Buffer.from('data')])

        // Return 429 to queue retries
        request.yields(null, null, 429)

        let doneCallCount = 0
        writer.flush(() => {
          doneCallCount++
        })
        writer.flush(() => {
          doneCallCount++
        })

        // Destroy before retries process
        setImmediate(() => {
          writer._destroy()

          // Both done callbacks should have been called
          expect(doneCallCount).to.equal(2)
          expect(log.debug).to.have.been.calledWith('Dropping queued retry due to writer cleanup')
          done()
        })
      })

      it('should clear pending timers on destroy', () => {
        const clock = sinon.useFakeTimers()

        encoder.count.returns(2)
        encoder.makePayload.returns([Buffer.from('data')])

        // Return 429 to schedule retries
        request.yields(null, null, 429)

        writer.flush(() => {})

        // Verify timer is scheduled
        expect(writer._retryTimer).to.not.be.null

        // Destroy should clear timer
        writer._destroy()
        expect(writer._retryTimer).to.be.null

        clock.restore()
      })
    })
  })
}

describe('Writer', () => {
  describe('0.4', () => describeWriter(0.4))

  describe('0.5', () => describeWriter(0.5))
})
