'use strict'
const { describe, it, beforeEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../../../../dd-trace/test/setup/core')

const id = require('../../../../src/id')

let CoverageWriter
let coverageWriter
let request
let encoder
let url
let log

describe('CI Visibility Coverage Writer', () => {
  beforeEach(() => {
    request = sinon.stub().yieldsAsync(null, 'OK', 200)

    encoder = {
      encode: sinon.stub(),
      count: sinon.stub().returns(0),
      makePayload: sinon.stub().returns({
        getHeaders: () => ({}),
        pipe: () => {},
        size: () => 1
      })
    }

    url = {
      protocol: 'https:',
      hostname: 'citestcov-intake.datadog.com'
    }

    log = {
      error: sinon.spy()
    }

    const CoverageCIVisibilityEncoder = function () {
      return encoder
    }

    CoverageWriter = proxyquire('../../../../src/ci-visibility/exporters/agentless/coverage-writer.js', {
      '../../../exporters/common/request': request,
      '../../../encode/coverage-ci-visibility': { CoverageCIVisibilityEncoder },
      '../../../log': log
    })
    coverageWriter = new CoverageWriter({ url })
  })

  describe('append', () => {
    it('should encode a coverage payload', () => {
      const input = { sessionId: id('1'), suiteId: id('2'), files: ['file.js'] }
      coverageWriter.append(input)

      sinon.assert.calledWith(encoder.encode, input)
    })
  })

  describe('flush', () => {
    it('should skip flushing if empty', () => {
      coverageWriter.flush()

      sinon.assert.notCalled(encoder.makePayload)
    })

    it('should empty the internal queue', () => {
      encoder.count.returns(1)

      coverageWriter.flush()

      sinon.assert.called(encoder.makePayload)
    })

    it('should call callback when empty', (done) => {
      coverageWriter.flush(done)
    })

    it('should flush its traces to the intake and call done', (done) => {
      encoder.count.returns(2)
      const payload = {
        getHeaders: () => ({}),
        pipe: () => {},
        size: () => 1
      }

      encoder.makePayload.returns(payload)
      coverageWriter.flush(() => {
        sinon.assert.calledWithMatch(request, payload, {
          url,
          path: '/api/v2/citestcov',
          method: 'POST'
        })
        done()
      })
    })

    it('should log request errors', done => {
      const error = new Error('boom')

      request.yields(error)

      const payload = {
        getHeaders: () => ({}),
        pipe: () => {},
        size: () => 1
      }

      encoder.count.returns(1)
      encoder.makePayload.returns(payload)

      coverageWriter.flush(() => {
        sinon.assert.calledWith(log.error, 'Error sending CI coverage payload', error)
        done()
      })
    })
  })
})
