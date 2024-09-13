'use strict'

require('../../setup/tap')

const ddsource = 'dd_debugger'
const service = 'my-service'
const runtimeId = 'my-runtime-id'

describe('diagnostic message http request caching', () => {
  let statusproxy, request

  const acks = [
    ['ackReceived', 'RECEIVED'],
    ['ackInstalled', 'INSTALLED'],
    ['ackEmitting', 'EMITTING'],
    ['ackError', 'ERROR', new Error('boom')]
  ]

  beforeEach(() => {
    request = sinon.spy()
    request['@noCallThru'] = true

    statusproxy = proxyquire('../src/debugger/devtools_client/status', {
      './config': { service, runtimeId, '@noCallThru': true },
      '../../exporters/common/request': request
    })
  })

  for (const [ackFnName, status, err] of acks) {
    describe(ackFnName, () => {
      let ackFn, exception

      beforeEach(() => {
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

      it('should only call once if no change', () => {
        ackFn({ id: 'foo', version: 0 })
        expect(request).to.have.been.calledOnce
        assertRequestData(request, { probeId: 'foo', version: 0, status, exception })

        ackFn({ id: 'foo', version: 0 })
        expect(request).to.have.been.calledOnce
      })

      it('should call again if version changes', () => {
        ackFn({ id: 'foo', version: 0 })
        expect(request).to.have.been.calledOnce
        assertRequestData(request, { probeId: 'foo', version: 0, status, exception })

        ackFn({ id: 'foo', version: 1 })
        expect(request).to.have.been.calledTwice
        assertRequestData(request, { probeId: 'foo', version: 1, status, exception })
      })

      it('should call again if probeId changes', () => {
        ackFn({ id: 'foo', version: 0 })
        expect(request).to.have.been.calledOnce
        assertRequestData(request, { probeId: 'foo', version: 0, status, exception })

        ackFn({ id: 'bar', version: 0 })
        expect(request).to.have.been.calledTwice
        assertRequestData(request, { probeId: 'bar', version: 0, status, exception })
      })
    })
  }
})

function assertRequestData (request, { probeId, version, status, exception }) {
  const payload = getFormPayload(request)
  const diagnostics = { probeId, runtimeId, version, status }

  // Error requests will also contain an `exception` property
  if (exception) diagnostics.exception = exception

  expect(payload).to.deep.equal({ ddsource, service, debugger: { diagnostics } })

  const opts = getRequestOptions(request)
  expect(opts).to.have.property('method', 'POST')
  expect(opts).to.have.property('path', '/debugger/v1/diagnostics')
}

function getRequestOptions (request) {
  return request.lastCall.args[1]
}

function getFormPayload (request) {
  const form = request.lastCall.args[0]
  const payload = form._data[form._data.length - 2] // the last element is an empty line
  return JSON.parse(payload)
}
