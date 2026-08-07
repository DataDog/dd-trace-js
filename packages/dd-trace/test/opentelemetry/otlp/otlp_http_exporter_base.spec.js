'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

require('../../setup/core')

const OtlpHttpExporterBase = require('../../../src/opentelemetry/otlp/otlp_http_exporter_base')

function respondWith (callback, statusCode = 200) {
  const res = {
    statusCode,
    on: (event, handler) => { if (event === 'data') handler('') },
    once: (event, handler) => { if (event === 'end') handler() },
  }
  callback(res)
}

// Captures the handlers `sendPayload` registers via `req.on`/`req.once` so tests can
// fire them directly (e.g. to simulate the timeout -> destroy() -> error sequence).
function createMockReq () {
  const handlers = {}
  const registerHandler = (event, handler) => { handlers[event] = handler }

  return {
    write: sinon.stub(),
    end: sinon.stub(),
    destroy: sinon.stub(),
    on: sinon.stub().callsFake(registerHandler),
    once: sinon.stub().callsFake(registerHandler),
    handlers,
  }
}

describe('OtlpHttpExporterBase', () => {
  let httpStub
  let pendingCallbacks
  let pendingReqs

  beforeEach(() => {
    pendingCallbacks = []
    pendingReqs = []

    httpStub = sinon.stub(http, 'request').callsFake((options, callback) => {
      pendingCallbacks.push(callback)
      const req = createMockReq()
      pendingReqs.push(req)
      return req
    })
  })

  afterEach(() => {
    httpStub.restore()
  })

  describe('flush', () => {
    it('calls done synchronously when there are no in-flight requests', () => {
      const exporter = new OtlpHttpExporterBase('http://localhost:4318/v1/traces', {}, 1000, 'http/json', 'traces')
      const done = sinon.spy()

      exporter.flush(done)

      sinon.assert.calledOnce(done)
    })

    it('waits for an in-flight request to complete before calling done', () => {
      const exporter = new OtlpHttpExporterBase('http://localhost:4318/v1/traces', {}, 1000, 'http/json', 'traces')
      const resultCallback = sinon.spy()

      exporter.sendPayload(Buffer.from('{}'), resultCallback)

      const done = sinon.spy()
      exporter.flush(done)

      sinon.assert.notCalled(done)

      respondWith(pendingCallbacks[0])

      sinon.assert.calledOnceWithExactly(resultCallback, { code: 0 })
      sinon.assert.calledOnce(done)
    })

    it('waits for every in-flight request before calling done', () => {
      const exporter = new OtlpHttpExporterBase('http://localhost:4318/v1/traces', {}, 1000, 'http/json', 'traces')

      exporter.sendPayload(Buffer.from('{}'), sinon.spy())
      exporter.sendPayload(Buffer.from('{}'), sinon.spy())

      const done = sinon.spy()
      exporter.flush(done)

      respondWith(pendingCallbacks[0])
      sinon.assert.notCalled(done)

      respondWith(pendingCallbacks[1])
      sinon.assert.calledOnce(done)
    })

    it('resolves callbacks for a failed request instead of hanging', () => {
      const exporter = new OtlpHttpExporterBase('http://localhost:4318/v1/traces', {}, 1000, 'http/json', 'traces')
      const resultCallback = sinon.spy()

      exporter.sendPayload(Buffer.from('{}'), resultCallback)

      const done = sinon.spy()
      exporter.flush(done)

      respondWith(pendingCallbacks[0], 500)

      sinon.assert.calledOnce(resultCallback)
      assert.strictEqual(resultCallback.firstCall.args[0].code, 1)
      sinon.assert.calledOnce(done)
    })

    it('resolves every registered flush callback once pending requests reach zero', () => {
      const exporter = new OtlpHttpExporterBase('http://localhost:4318/v1/traces', {}, 1000, 'http/json', 'traces')

      exporter.sendPayload(Buffer.from('{}'), sinon.spy())

      const first = sinon.spy()
      const second = sinon.spy()
      exporter.flush(first)
      exporter.flush(second)

      respondWith(pendingCallbacks[0])

      sinon.assert.calledOnce(first)
      sinon.assert.calledOnce(second)
    })

    it('does not require a done callback', () => {
      const exporter = new OtlpHttpExporterBase('http://localhost:4318/v1/traces', {}, 1000, 'http/json', 'traces')

      exporter.flush()
    })

    it('does not resolve flush early when a timed-out request also emits a subsequent error', () => {
      // Simulates destroy()'s "socket hang up" firing after the timeout handler already ran.
      const exporter = new OtlpHttpExporterBase('http://localhost:4318/v1/traces', {}, 1000, 'http/json', 'traces')
      const resultCallbackA = sinon.spy()
      const resultCallbackB = sinon.spy()

      exporter.sendPayload(Buffer.from('{}'), resultCallbackA)
      exporter.sendPayload(Buffer.from('{}'), resultCallbackB)

      const done = sinon.spy()
      exporter.flush(done)

      pendingReqs[0].handlers.timeout()

      sinon.assert.calledOnce(pendingReqs[0].destroy)
      sinon.assert.calledOnce(resultCallbackA)
      sinon.assert.notCalled(done)

      pendingReqs[0].handlers.error(new Error('socket hang up'))

      sinon.assert.calledOnce(resultCallbackA)
      sinon.assert.notCalled(done)

      respondWith(pendingCallbacks[1])

      sinon.assert.calledOnce(resultCallbackB)
      sinon.assert.calledOnce(done)
    })
  })
})
