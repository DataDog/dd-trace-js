'use strict'

const t = require('tap')
require('../../../../../dd-trace/test/setup/core')

const proxyquire = require('proxyquire')
const { expect } = require('chai')

const id = require('../../../../src/id')

let CoverageWriter
let coverageWriter
let request
let encoder
let url
let log

t.test('CI Visibility Coverage Writer', t => {
  t.beforeEach(() => {
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

  t.test('append', t => {
    t.test('should encode a coverage payload', t => {
      const input = { sessionId: id('1'), suiteId: id('2'), files: ['file.js'] }
      coverageWriter.append(input)

      expect(encoder.encode).to.have.been.calledWith(input)
      t.end()
    })
    t.end()
  })

  t.test('flush', t => {
    t.test('should skip flushing if empty', t => {
      coverageWriter.flush()

      expect(encoder.makePayload).to.not.have.been.called
      t.end()
    })

    t.test('should empty the internal queue', t => {
      encoder.count.returns(1)

      coverageWriter.flush()

      expect(encoder.makePayload).to.have.been.called
      t.end()
    })

    t.test('should call callback when empty', (t) => {
      coverageWriter.flush(t.end)
    })

    t.test('should flush its traces to the intake and call done', (t) => {
      encoder.count.returns(2)
      const payload = {
        getHeaders: () => ({}),
        pipe: () => {},
        size: () => 1
      }

      encoder.makePayload.returns(payload)
      coverageWriter.flush(() => {
        expect(request).to.have.been.calledWithMatch(payload, {
          url,
          path: '/api/v2/citestcov',
          method: 'POST'
        })
        t.end()
      })
    })

    t.test('should log request errors', t => {
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
        expect(log.error).to.have.been.calledWith('Error sending CI coverage payload', error)
        t.end()
      })
    })
    t.end()
  })
  t.end()
})
