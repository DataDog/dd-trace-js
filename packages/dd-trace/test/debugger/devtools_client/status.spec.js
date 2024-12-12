'use strict'

require('../../setup/mocha')

const { expectWithin, getRequestOptions } = require('./utils')
const JSONQueue = require('../../../src/debugger/devtools_client/queue')

const ddsource = 'dd_debugger'
const service = 'my-service'
const runtimeId = 'my-runtime-id'

describe('diagnostic message http requests', function () {
  let statusproxy, request, queue

  const acks = [
    ['ackReceived', 'RECEIVED'],
    ['ackInstalled', 'INSTALLED'],
    ['ackEmitting', 'EMITTING'],
    ['ackError', 'ERROR', new Error('boom')]
  ]

  beforeEach(function () {
    request = sinon.spy()
    request['@noCallThru'] = true

    class JSONQueueSpy extends JSONQueue {
      constructor (...args) {
        super(...args)
        queue = this
        sinon.spy(this, 'add')
      }
    }

    statusproxy = proxyquire('../src/debugger/devtools_client/status', {
      './config': { service, runtimeId, '@noCallThru': true },
      './queue': JSONQueueSpy,
      '../../exporters/common/request': request
    })
  })

  for (const [ackFnName, status, err] of acks) {
    describe(ackFnName, function () {
      let ackFn, exception

      beforeEach(function () {
        if (err) {
          ackFn = statusproxy[ackFnName].bind(null, err)
          // Use `JSON.stringify` to remove any fields that are `undefined`
          exception = JSON.parse(JSON.stringify({
            type: err.code,
            message: err.message,
            stacktrace: err.stack
          }))
        } else {
          ackFn = statusproxy[ackFnName]
          exception = undefined
        }
      })

      it('should queue instead of calling request directly', function () {
        ackFn({ id: 'foo', version: 0 })
        expect(request).to.not.have.been.called
        expect(queue.add).to.have.been.calledOnceWith(
          JSON.stringify(formatAsDiagnosticsEvent({ probeId: 'foo', version: 0, status, exception }))
        )
      })

      it('should only add to queue once if no change', function () {
        ackFn({ id: 'foo', version: 0 })
        expect(queue.add).to.have.been.calledOnceWith(
          JSON.stringify(formatAsDiagnosticsEvent({ probeId: 'foo', version: 0, status, exception }))
        )

        ackFn({ id: 'foo', version: 0 })
        expect(queue.add).to.have.been.calledOnce
      })

      it('should add to queue again if version changes', function () {
        ackFn({ id: 'foo', version: 0 })
        expect(queue.add).to.have.been.calledOnceWith(
          JSON.stringify(formatAsDiagnosticsEvent({ probeId: 'foo', version: 0, status, exception }))
        )

        ackFn({ id: 'foo', version: 1 })
        expect(queue.add).to.have.been.calledTwice
        expect(queue.add.lastCall).to.have.been.calledWith(
          JSON.stringify(formatAsDiagnosticsEvent({ probeId: 'foo', version: 1, status, exception }))
        )
      })

      it('should add to queue again if probeId changes', function () {
        ackFn({ id: 'foo', version: 0 })
        expect(queue.add).to.have.been.calledOnceWith(
          JSON.stringify(formatAsDiagnosticsEvent({ probeId: 'foo', version: 0, status, exception }))
        )

        ackFn({ id: 'bar', version: 0 })
        expect(queue.add).to.have.been.calledTwice
        expect(queue.add.lastCall).to.have.been.calledWith(
          JSON.stringify(formatAsDiagnosticsEvent({ probeId: 'bar', version: 0, status, exception }))
        )
      })

      it('should call request with the expected payload once the queue is flushed', function (done) {
        ackFn({ id: 'foo', version: 0 })
        ackFn({ id: 'foo', version: 1 })
        ackFn({ id: 'bar', version: 0 })
        expect(request).to.not.have.been.called

        expectWithin(1200, () => {
          expect(request).to.have.been.calledOnce

          const payload = getFormPayload(request)

          expect(payload).to.deep.equal([
            formatAsDiagnosticsEvent({ probeId: 'foo', version: 0, status, exception }),
            formatAsDiagnosticsEvent({ probeId: 'foo', version: 1, status, exception }),
            formatAsDiagnosticsEvent({ probeId: 'bar', version: 0, status, exception })
          ])

          const opts = getRequestOptions(request)
          expect(opts).to.have.property('method', 'POST')
          expect(opts).to.have.property('path', '/debugger/v1/diagnostics')

          done()
        })
      })
    })
  }
})

function formatAsDiagnosticsEvent ({ probeId, version, status, exception }) {
  const diagnostics = { probeId, runtimeId, probeVersion: version, status }

  // Error requests will also contain an `exception` property
  if (exception) diagnostics.exception = exception

  return { ddsource, service, debugger: { diagnostics } }
}

function getFormPayload (request) {
  const form = request.lastCall.args[0]
  const payload = form._data[form._data.length - 2] // the last element is an empty line
  return JSON.parse(payload)
}
