'use strict'

require('../../setup/mocha')

const sinon = require('sinon')
const { getRequestOptions } = require('./utils')
const JSONBuffer = require('../../../src/debugger/devtools_client/json-buffer')

const ddsource = 'dd_debugger'
const service = 'my-service'
const runtimeId = 'my-runtime-id'

describe('diagnostic message http requests', function () {
  let clock, statusproxy, request, jsonBuffer

  const acks = [
    ['ackReceived', 'RECEIVED'],
    ['ackInstalled', 'INSTALLED'],
    ['ackEmitting', 'EMITTING'],
    ['ackError', 'ERROR', new Error('boom')]
  ]

  beforeEach(function () {
    clock = sinon.useFakeTimers()

    request = sinon.spy()
    request['@noCallThru'] = true

    class JSONBufferSpy extends JSONBuffer {
      constructor (...args) {
        super(...args)
        jsonBuffer = this
        sinon.spy(this, 'write')
      }
    }

    statusproxy = proxyquire('../src/debugger/devtools_client/status', {
      './config': {
        service,
        runtimeId,
        maxTotalPayloadSize: 5 * 1024 * 1024, // 5MB
        dynamicInstrumentation: {
          uploadIntervalSeconds: 1
        },
        '@noCallThru': true
      },
      './json-buffer': JSONBufferSpy,
      '../../exporters/common/request': request
    })
  })

  afterEach(function () {
    clock.restore()
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

      it('should buffer instead of calling request directly', function () {
        ackFn({ id: 'foo', version: 0 })
        expect(request).to.not.have.been.called
        expect(jsonBuffer.write).to.have.been.calledOnceWith(
          JSON.stringify(formatAsDiagnosticsEvent({ probeId: 'foo', version: 0, status, exception }))
        )
      })

      it('should only add to buffer once if no change', function () {
        ackFn({ id: 'foo', version: 0 })
        expect(jsonBuffer.write).to.have.been.calledOnceWith(
          JSON.stringify(formatAsDiagnosticsEvent({ probeId: 'foo', version: 0, status, exception }))
        )

        ackFn({ id: 'foo', version: 0 })
        expect(jsonBuffer.write).to.have.been.calledOnce
      })

      it('should add to buffer again if version changes', function () {
        ackFn({ id: 'foo', version: 0 })
        expect(jsonBuffer.write).to.have.been.calledOnceWith(
          JSON.stringify(formatAsDiagnosticsEvent({ probeId: 'foo', version: 0, status, exception }))
        )

        ackFn({ id: 'foo', version: 1 })
        expect(jsonBuffer.write).to.have.been.calledTwice
        expect(jsonBuffer.write.lastCall).to.have.been.calledWith(
          JSON.stringify(formatAsDiagnosticsEvent({ probeId: 'foo', version: 1, status, exception }))
        )
      })

      it('should add to buffer again if probeId changes', function () {
        ackFn({ id: 'foo', version: 0 })
        expect(jsonBuffer.write).to.have.been.calledOnceWith(
          JSON.stringify(formatAsDiagnosticsEvent({ probeId: 'foo', version: 0, status, exception }))
        )

        ackFn({ id: 'bar', version: 0 })
        expect(jsonBuffer.write).to.have.been.calledTwice
        expect(jsonBuffer.write.lastCall).to.have.been.calledWith(
          JSON.stringify(formatAsDiagnosticsEvent({ probeId: 'bar', version: 0, status, exception }))
        )
      })

      it('should call request with the expected payload once the buffer is flushed', function (done) {
        ackFn({ id: 'foo', version: 0 })
        ackFn({ id: 'foo', version: 1 })
        ackFn({ id: 'bar', version: 0 })
        expect(request).to.not.have.been.called

        clock.tick(1000)

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
