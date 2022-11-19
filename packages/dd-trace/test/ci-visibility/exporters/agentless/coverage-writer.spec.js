'use strict'

require('../../../setup/core')

const proxyquire = require('proxyquire')
const { expect } = require('chai')

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
        pipe: () => {}
      })
    }

    url = {
      protocol: 'https:',
      hostname: 'event-platform-intake.datadog.com'
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
      const input = { traceId: id('1'), spanId: id('2'), files: ['file.js'] }
      coverageWriter.append(input)

      expect(encoder.encode).to.have.been.calledWith(input)
    })
  })

  describe('flush', () => {
    it('should skip flushing if empty', () => {
      coverageWriter.flush()

      expect(encoder.makePayload).to.not.have.been.called
    })

    it('should empty the internal queue', () => {
      encoder.count.returns(1)

      coverageWriter.flush()

      expect(encoder.makePayload).to.have.been.called
    })

    it('should call callback when empty', (done) => {
      coverageWriter.flush(done)
    })

    it('should flush its traces to the intake and call done', (done) => {
      encoder.count.returns(2)
      const payload = {
        getHeaders: () => ({}),
        pipe: () => {}
      }

      encoder.makePayload.returns(payload)
      coverageWriter.flush(() => {
        expect(request).to.have.been.calledWithMatch(payload, {
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
        pipe: () => {}
      }

      encoder.count.returns(1)
      encoder.makePayload.returns(payload)

      coverageWriter.flush(() => {
        expect(log.error).to.have.been.calledWith(error)
        done()
      })
    })
  })
})
