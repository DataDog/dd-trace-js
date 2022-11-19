'use strict'

require('../../../setup/tap')

const proxyquire = require('proxyquire')
const { expect } = require('chai')

let Writer
let writer
let span
let request
let encoder
let coverageEncoder
let url
let log

describe('CI Visibility Writer', () => {
  beforeEach(() => {
    span = 'formatted'

    request = sinon.stub().yieldsAsync(null, 'OK', 200)

    encoder = {
      encode: sinon.stub(),
      count: sinon.stub().returns(0),
      makePayload: sinon.stub().returns([])
    }

    url = {
      protocol: 'https:',
      hostname: 'citestcycle-intake.datadog.com'
    }

    log = {
      error: sinon.spy()
    }

    const AgentlessCiVisibilityEncoder = function () {
      return encoder
    }

    coverageEncoder = {
      encode: sinon.stub(),
      count: sinon.stub().returns(0),
      makePayload: sinon.stub().returns([])
    }

    const CoverageCIVisibilityEncoder = function () {
      return coverageEncoder
    }

    Writer = proxyquire('../../../../src/ci-visibility/exporters/agentless/writer', {
      '../../../exporters/common/request': request,
      '../../../encode/agentless-ci-visibility': { AgentlessCiVisibilityEncoder },
      '../../../encode/coverage-ci-visibility': { CoverageCIVisibilityEncoder },
      '../../../log': log
    })
    writer = new Writer({ url, tags: { 'runtime-id': 'runtime-id' }, coverageUrl: url })
  })

  describe('append', () => {
    it('should encode a trace', () => {
      writer.append([span])

      expect(encoder.encode).to.have.been.calledWith([span])
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

    it('should flush its traces to the intake, and call callback', (done) => {
      const expectedData = Buffer.from('prefixed')

      encoder.count.returns(2)
      encoder.makePayload.returns([expectedData])

      writer.flush(() => {
        expect(request).to.have.been.calledWithMatch([expectedData], {
          url,
          path: '/api/v2/citestcycle',
          method: 'POST',
          headers: {
            'Content-Type': 'application/msgpack'
          }
        })
        done()
      })
    })

    describe('when request fails', function () {
      it('should log request errors', done => {
        const error = new Error('boom')

        request.yields(error)

        encoder.count.returns(1)

        writer.flush(() => {
          expect(log.error).to.have.been.calledWith(error)
          done()
        })
      })
    })
  })
})
