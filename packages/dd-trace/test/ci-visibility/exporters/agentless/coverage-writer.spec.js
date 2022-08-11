'use strict'

const proxyquire = require('proxyquire')
const { expect } = require('chai')

let CoverageWriter
let coverageWriter
let span
let coverage
let request
let encoder
let url
let log

describe.only('CI Visibility Coverage Writer', () => {
  beforeEach(() => {
    span = {
      context: () => ({ _traceId: id('1'), _spanId: id('2') })
    }
    coverage = ['file.js']

    request = sinon.stub().yieldsAsync({ on: () => {} }).returns({ on: () => {}})

    encoder = {
      append: sinon.stub(),
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

    const CIVisibilityCoverageEncoder = function () {
      return encoder
    }

    CoverageWriter = proxyquire('../../../../src/ci-visibility/exporters/agentless/coverage-writer.js', {
      'https': { request },
      '../../../encode/ci-visibility-coverage': { CIVisibilityCoverageEncoder },
      '../../../log': log
    })
    coverageWriter = new CoverageWriter({ url })
  })

  describe('append', () => {
    it('should append a coverage payload', () => {
      const input = { span, coverage }
      coverageWriter.append(input)

      expect(encoder.append).to.have.been.calledWith(input)
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

    it('should flush its traces to the intake', () => {
      encoder.count.returns(2)
      encoder.makePayload.returns({
        getHeaders: () => ({}),
        pipe: () => {}
      })
      coverageWriter.flush()
      expect(request).to.have.been.calledWithMatch({
        protocol: url.protocol,
        hostname: url.hostname,
        path: '/api/v2/citestcov',
        method: 'POST'
      })
    })
  })
})
