'use strict'

const t = require('tap')
require('../../../../../dd-trace/test/setup/core')

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

t.test('CI Visibility Writer', t => {
  t.beforeEach(() => {
    span = 'formatted'

    request = sinon.stub().yieldsAsync(null, 'OK', 200)

    encoder = {
      encode: sinon.stub(),
      count: sinon.stub().returns(0),
      makePayload: sinon.stub().returns(Buffer.from(''))
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

    t.test('should flush its traces to the intake, and call callback', (t) => {
      const expectedData = Buffer.from('prefixed')

      encoder.count.returns(2)
      encoder.makePayload.returns(expectedData)

      writer.flush(() => {
        expect(request).to.have.been.calledWithMatch(expectedData, {
          url,
          path: '/api/v2/citestcycle',
          method: 'POST',
          headers: {
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
          expect(log.error).to.have.been.calledWith('Error sending CI agentless payload', error)
          t.end()
        })
      })
      t.end()
    })
    t.end()
  })
  t.end()
})
