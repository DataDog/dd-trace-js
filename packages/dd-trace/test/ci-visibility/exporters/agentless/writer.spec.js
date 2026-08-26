'use strict'

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../../../../dd-trace/test/setup/core')

const { getAgent } = require('../../../../src/ci-visibility/exporters/agents')

let isOriginSaturated

let Writer
let writer
let span
let request
let encoder
let coverageEncoder
let url
let log
let incrementCountMetric

describe('CI Visibility Writer', () => {
  beforeEach(() => {
    span = 'formatted'

    request = sinon.stub().yieldsAsync(null, 'OK', 200)

    encoder = {
      encode: sinon.stub(),
      count: sinon.stub().returns(0),
      makePayload: sinon.stub().returns(Buffer.from('')),
    }

    url = {
      protocol: 'https:',
      hostname: 'citestcycle-intake.datadog.com',
    }

    log = {
      error: sinon.spy(),
    }
    incrementCountMetric = sinon.stub()
    isOriginSaturated = () => false

    const AgentlessCiVisibilityEncoder = function () {
      return encoder
    }

    coverageEncoder = {
      encode: sinon.stub(),
      count: sinon.stub().returns(0),
      makePayload: sinon.stub().returns([]),
    }

    const CoverageCIVisibilityEncoder = function () {
      return coverageEncoder
    }

    Writer = proxyquire('../../../../src/ci-visibility/exporters/agentless/writer', {
      '../request': request,
      '../agents': { getAgent, isOriginSaturated: (...args) => isOriginSaturated(...args) },
      '../../../encode/agentless-ci-visibility': { AgentlessCiVisibilityEncoder },
      '../../../encode/coverage-ci-visibility': { CoverageCIVisibilityEncoder },
      '../../../ci-visibility/telemetry': { incrementCountMetric },
      '../../../log': log,
    })
    writer = new Writer({ url, tags: { 'runtime-id': 'runtime-id' }, coverageUrl: url })
  })

  describe('append', () => {
    it('should encode a trace', () => {
      writer.append([span])

      sinon.assert.calledWith(encoder.encode, [span])
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

    it('should flush its traces to the intake, and call callback', (done) => {
      const expectedData = Buffer.from('prefixed')

      encoder.count.returns(2)
      encoder.makePayload.returns(expectedData)

      writer.flush(() => {
        sinon.assert.calledWithMatch(request, expectedData, {
          url,
          path: '/api/v2/citestcycle',
          method: 'POST',
          headers: {
            'Content-Type': 'application/msgpack',
          },
          agent: getAgent(url),
        })
        done()
      })
    })

    describe('when request fails', function () {
      it('should log request errors', done => {
        const error = new Error('boom')
        error.code = 'ECONNRESET'

        request.yields(error)

        encoder.count.returns(1)

        writer.flush(() => {
          sinon.assert.calledWith(log.error, 'Error sending CI agentless payload', error)
          sinon.assert.calledWithExactly(
            incrementCountMetric,
            'endpoint_payload.dropped',
            { endpoint: 'test_cycle', statusCode: 'ECONNRESET' }
          )
          done()
        })
      })
    })

    describe('size-gated flush coalescing', () => {
      it('defers a background flush while the intake origin is saturated', (done) => {
        encoder.count.returns(1)
        encoder._traceBytes = { length: 1_000_000 }
        isOriginSaturated = () => true

        const callback = sinon.spy()
        writer.flush(callback)

        sinon.assert.calledOnceWithExactly(callback)
        sinon.assert.notCalled(request)
        done()
      })

      it('flushes near the encoder hard cap even when saturated', (done) => {
        encoder.count.returns(1)
        encoder._traceBytes = { length: 50_000_000 }
        isOriginSaturated = () => true

        writer.flush(() => {
          sinon.assert.calledOnce(request)
          done()
        })
      })

      it('flushes when the intake origin is idle', (done) => {
        encoder.count.returns(1)
        encoder._traceBytes = { length: 1_000_000 }
        isOriginSaturated = () => false

        writer.flush(() => {
          sinon.assert.calledOnce(request)
          done()
        })
      })

      it('always flushes a final flush with a deadline even when saturated', (done) => {
        encoder.count.returns(1)
        encoder._traceBytes = { length: 1_000_000 }
        isOriginSaturated = () => true

        writer.flush(() => {
          sinon.assert.calledOnce(request)
          done()
        }, { deadline: Date.now() + 20_000 })
      })
    })
  })
})
