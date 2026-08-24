'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../../../../dd-trace/test/setup/core')

let Writer
let writer
let span
let request
let encoder
let coverageEncoder
let url
let log
let incrementCountMetric
let agent

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
      debug: sinon.stub().callsFake(message => typeof message === 'function' ? message() : message),
      error: sinon.spy(),
    }
    incrementCountMetric = sinon.stub()
    agent = {}
    agent.sockets = { active: agent }

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
      '../agents': { getAgent: sinon.stub().returns(agent) },
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
          agent,
        })
        done()
      })
    })

    it('should omit active agent state from debug logs', (done) => {
      encoder.count.returns(1)

      writer.flush(() => {
        const debugMessage = log.debug.firstCall.returnValue
        assert.match(debugMessage, /^Request to the intake: /)
        assert.doesNotMatch(debugMessage, /"agent"/)
        done()
      })
    })

    describe('when request fails', function () {
      it('should log request errors', done => {
        const error = Object.assign(new Error('Error from https://example.invalid/path: unavailable'), {
          code: 'ECONNRESET',
          status: 503,
        })

        request.yields(error, null, 503)

        encoder.count.returns(1)

        writer.flush(() => {
          sinon.assert.calledWithExactly(
            log.error,
            'Test Optimization payload dropped: %s',
            JSON.stringify({
              endpoint: 'test_cycle',
              code: 'ECONNRESET',
              statusCode: 503,
              message: 'Error from [redacted] unavailable',
            })
          )
          sinon.assert.calledWithExactly(
            incrementCountMetric,
            'endpoint_payload.dropped',
            { endpoint: 'test_cycle' }
          )
          done()
        })
      })
    })
  })
})
