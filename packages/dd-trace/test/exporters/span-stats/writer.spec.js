'use strict'

const t = require('tap')
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

t.test('span-stats writer', t => {
  t.beforeEach(() => {
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

  t.test('append', t => {
    t.test('should encode a trace', t => {
      writer.append([span])

      expect(encoder.encode).to.have.been.calledWith([span])
      t.end()
    })
    t.end()
  })

  t.test('flush', t => {
    t.test('should skip flushing if empty', t => {
      writer.flush()

      expect(encoder.makePayload).to.not.have.been.called
      t.end()
    })

    t.test('should empty the internal queue', t => {
      encoder.count.returns(1)

      writer.flush()

      expect(encoder.makePayload).to.have.been.called
      t.end()
    })

    t.test('should call callback when empty', (t) => {
      writer.flush(t.end)
    })

    t.test('should flush to the agent, and call callback', (t) => {
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
        t.end()
      })
    })

    t.test('when request fails', function (t) {
      t.test('should log request errors', t => {
        const error = new Error('boom')

        request.yields(error)

        encoder.count.returns(1)

        writer.flush(() => {
          expect(log.error).to.have.been.calledWith('Error sending span stats', error)
          t.end()
        })
      })
      t.end()
    })
    t.end()
  })
  t.end()
})
