'use strict'

require('../../setup/core')

const proxyquire = require('proxyquire')
const { expect } = require('chai')

const pkg = require('../../../../../package.json')

let Writer
let writer
let span
let request
let encoder
let url
let log

describe('span-stats writer', () => {
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
      hostname: '127.0.0.1:8126'
    }

    log = {
      error: sinon.spy()
    }

    const SpanStatsEncoder = function () {
      return encoder
    }

    Writer = proxyquire('../../../src/exporters/span-stats/writer', {
      '../common/request': request,
      '../../encode/span-stats': { SpanStatsEncoder },
      '../../log': log
    }).Writer
    writer = new Writer({ url, tags: { 'runtime-id': 'runtime-id' } })
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

    it('should flush to the agent, and call callback', (done) => {
      const expectedData = Buffer.from('prefixed')

      encoder.count.returns(2)
      encoder.makePayload.returns([expectedData])

      writer.flush(() => {
        expect(request).to.have.been.calledWithMatch([expectedData], {
          protocol: url.protocol,
          hostname: url.hostname,
          path: '/v0.6/stats',
          method: 'PUT',
          headers: {
            'Datadog-Meta-Lang': 'javascript',
            'Datadog-Meta-Tracer-Version': pkg.version,
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
