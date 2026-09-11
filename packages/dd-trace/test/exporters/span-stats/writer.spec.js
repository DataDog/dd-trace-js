'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../setup/core')
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
      makePayload: sinon.stub().returns([]),
    }

    url = {
      protocol: 'https:',
      hostname: '127.0.0.1:8126',
    }

    log = {
      error: sinon.spy(),
    }

    const SpanStatsEncoder = function () {
      return encoder
    }

    Writer = proxyquire('../../../src/exporters/span-stats/writer', {
      '../common/request': request,
      '../../encode/span-stats': { SpanStatsEncoder },
      '../../log': log,
      '../../serverless': { IS_AWS_LAMBDA_MICROVM: false },
    }).Writer
    writer = new Writer({ url, tags: { 'runtime-id': 'runtime-id' } })
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

    it('routes encoder-triggered flushes through the configured delivery tracker', () => {
      const deliveryTracker = { track: sinon.stub().callsFake((flush, done) => flush(done)) }
      writer = new Writer({ url, deliveryTracker })
      encoder.count.returns(1)
      encoder.encode.callsFake(() => writer.flush())

      writer.append([span])

      sinon.assert.calledOnce(deliveryTracker.track)
    })

    it('should flush to the agent, and call callback', (done) => {
      const expectedData = Buffer.from('prefixed')

      encoder.count.returns(2)
      encoder.makePayload.returns([expectedData])

      writer.flush(() => {
        sinon.assert.calledWithMatch(request, [expectedData], {
          url,
          path: '/v0.6/stats',
          method: 'PUT',
          headers: {
            'Datadog-Meta-Lang': 'javascript',
            'Datadog-Meta-Tracer-Version': pkg.version,
            'Content-Type': 'application/msgpack',
          },
        })
        assert.strictEqual(request.firstCall.args[1].resetController, undefined)
        done()
      })
    })

    it('passes a reset controller in a MicroVM', (done) => {
      const SpanStatsEncoder = function () {
        return encoder
      }
      const MicroVmWriter = proxyquire('../../../src/exporters/span-stats/writer', {
        '../common/request': request,
        '../../encode/span-stats': { SpanStatsEncoder },
        '../../log': log,
        '../../serverless': { IS_AWS_LAMBDA_MICROVM: true },
      }).Writer
      const microVmWriter = new MicroVmWriter({ url })
      encoder.count.returns(1)
      encoder.makePayload.returns([Buffer.from('prefixed')])

      microVmWriter.flush(() => {
        assert.ok(request.firstCall.args[1].resetController)
        done()
      })
    })

    // The writer must hand the agent URL to request() rather than pre-setting
    // protocol/hostname/port itself. Only request() knows to map a `unix:` URL
    // onto options.socketPath; a forced `protocol: 'unix:'` reaches
    // http.request unmapped and throws ERR_INVALID_PROTOCOL, dropping span
    // stats. request.spec.js covers the URL -> socketPath mapping itself.
    it('should pass the agent URL through for a unix socket instead of forcing the protocol', (done) => {
      url = new URL('unix://./pipe/datadog')
      writer = new Writer({ url, tags: { 'runtime-id': 'runtime-id' } })

      encoder.count.returns(1)
      encoder.makePayload.returns([Buffer.from('prefixed')])

      writer.flush(() => {
        const options = request.getCall(0).args[1]
        assert.strictEqual(options.url, url)
        assert.ok(!('protocol' in options), 'must not pre-set protocol')
        assert.ok(!('hostname' in options), 'must not pre-set hostname')
        done()
      })
    })

    describe('when request fails', function () {
      it('should log request errors', done => {
        const error = new Error('boom')

        request.yields(error)

        encoder.count.returns(1)

        writer.flush(() => {
          sinon.assert.calledWith(log.error, 'Error sending span stats', error)
          done()
        })
      })
    })
  })
})
