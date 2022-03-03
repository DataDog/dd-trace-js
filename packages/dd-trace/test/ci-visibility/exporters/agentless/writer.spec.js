'use strict'

const proxyquire = require('proxyquire')
const { expect } = require('chai')

let Writer
let writer
let span
let request
let encoder
let url
let log

const NUM_RETRIES = 1

describe('CI Visibility Writer', () => {
  beforeEach(() => {
    span = 'formatted'

    request = sinon.stub().yieldsAsync(null, 'OK', 200)

    encoder = {
      append: sinon.stub(),
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

    Writer = proxyquire('../../../../src/ci-visibility/exporters/agentless/writer', {
      './request': request,
      '../../../encode/agentless-ci-visibility': { AgentlessCiVisibilityEncoder },
      '../../../log': log
    })
    writer = new Writer({ url, tags: { 'runtime-id': 'runtime-id' }, numRetries: NUM_RETRIES })
  })

  describe('append', () => {
    it('should append a trace', () => {
      writer.append([span])

      expect(encoder.append).to.have.been.calledWith([span])
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
          protocol: url.protocol,
          hostname: url.hostname,
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
      this.timeout(100000)
      it('should log request errors', done => {
        const error = new Error('boom')

        request.yields(error)

        encoder.count.returns(1)

        writer.flush(() => {
          expect(log.error).to.have.been.calledWith(error)
          done()
        })
      })
      it('should retry up to NUM_RETRIES times', done => {
        const error = new Error('boom')

        request.yields(error)

        encoder.count.returns(1)

        writer.flush(() => {
          expect(request.callCount).to.equal(NUM_RETRIES + 1)
          expect(log.error.callCount).to.equal(NUM_RETRIES + 1)
          done()
        })
      })
    })
  })
})
