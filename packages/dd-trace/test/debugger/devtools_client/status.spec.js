'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')
require('../../setup/mocha')

const { DROPPED_REASON, EVENT_TYPE } = require('../../../src/debugger/guardrail-metrics')
const JSONBuffer = require('../../../src/debugger/devtools_client/json-buffer')
const { DEBUGGER_DIAGNOSTICS_V1 } = require('../../../src/debugger/constants')
const { getRequestOptions } = require('./utils')

const ddsource = 'dd_debugger'
const service = 'my-service'
const runtimeId = 'my-runtime-id'

describe('diagnostic message http requests', function () {
  let clock, statusproxy, request, jsonBuffer
  /** @type {{ eventDropped: sinon.SinonStub, '@noCallThru': boolean }} */
  let guardrailMetrics

  /** @type {Array<[string, string] | [string, string, Error]>} */
  const acks = [
    ['ackReceived', 'RECEIVED'],
    ['ackInstalled', 'INSTALLED'],
    ['ackEmitting', 'EMITTING'],
    ['ackError', 'ERROR', new Error('boom')],
  ]

  beforeEach(function () {
    clock = sinon.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })

    request = sinon.spy()
    request['@noCallThru'] = true

    guardrailMetrics = { eventDropped: sinon.stub(), '@noCallThru': true }

    class JSONBufferSpy extends JSONBuffer {
      /** @param {ConstructorParameters<typeof JSONBuffer>} args */
      constructor (...args) {
        super(...args)
        jsonBuffer = this
        sinon.spy(this, 'write')
      }
    }

    statusproxy = proxyquire('../../../src/debugger/devtools_client/status', {
      './config': {
        service,
        runtimeId,
        maxTotalPayloadSize: 5 * 1024 * 1024, // 5MB
        dynamicInstrumentation: {
          uploadIntervalSeconds: 1,
        },
        '@noCallThru': true,
      },
      './guardrail-metrics': guardrailMetrics,
      './json-buffer': JSONBufferSpy,
      '../../exporters/common/request': request,
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
          exception = {
            message: err.message,
            stacktrace: err.stack,
          }
        } else {
          ackFn = statusproxy[ackFnName]
          exception = undefined
        }
      })

      it('should buffer instead of calling request directly', function () {
        ackFn({ id: 'foo', version: 0 })
        sinon.assert.notCalled(request)
        sinon.assert.calledOnceWithExactly(jsonBuffer.write,
          JSON.stringify(formatAsDiagnosticsEvent({ probeId: 'foo', version: 0, status, exception }))
        )
      })

      it('should only add to buffer once if no change', function () {
        ackFn({ id: 'foo', version: 0 })
        sinon.assert.calledOnceWithExactly(jsonBuffer.write,
          JSON.stringify(formatAsDiagnosticsEvent({ probeId: 'foo', version: 0, status, exception }))
        )

        ackFn({ id: 'foo', version: 0 })
        sinon.assert.calledOnce(jsonBuffer.write)
      })

      it('should add to buffer again if version changes', function () {
        ackFn({ id: 'foo', version: 0 })
        sinon.assert.calledOnceWithExactly(jsonBuffer.write,
          JSON.stringify(formatAsDiagnosticsEvent({ probeId: 'foo', version: 0, status, exception }))
        )

        ackFn({ id: 'foo', version: 1 })
        sinon.assert.calledTwice(jsonBuffer.write)
        sinon.assert.calledWith(jsonBuffer.write.lastCall,
          JSON.stringify(formatAsDiagnosticsEvent({ probeId: 'foo', version: 1, status, exception }))
        )
      })

      it('should add to buffer again if probeId changes', function () {
        ackFn({ id: 'foo', version: 0 })
        sinon.assert.calledOnceWithExactly(jsonBuffer.write,
          JSON.stringify(formatAsDiagnosticsEvent({ probeId: 'foo', version: 0, status, exception }))
        )

        ackFn({ id: 'bar', version: 0 })
        sinon.assert.calledTwice(jsonBuffer.write)
        sinon.assert.calledWith(jsonBuffer.write.lastCall,
          JSON.stringify(formatAsDiagnosticsEvent({ probeId: 'bar', version: 0, status, exception }))
        )
      })

      it('should call request with the expected payload once the buffer is flushed', function (done) {
        ackFn({ id: 'foo', version: 0 })
        ackFn({ id: 'foo', version: 1 })
        ackFn({ id: 'bar', version: 0 })
        sinon.assert.notCalled(request)

        clock.tick(1000)

        sinon.assert.calledOnce(request)

        const payload = getFormPayload(request)

        assert.deepStrictEqual(payload, [
          formatAsDiagnosticsEvent({ probeId: 'foo', version: 0, status, exception }),
          formatAsDiagnosticsEvent({ probeId: 'foo', version: 1, status, exception }),
          formatAsDiagnosticsEvent({ probeId: 'bar', version: 0, status, exception }),
        ])

        const opts = getRequestOptions(request)
        assert.strictEqual(opts.method, 'POST')
        assert.strictEqual(opts.path, DEBUGGER_DIAGNOSTICS_V1)

        done()
      })
    })
  }

  describe('diagnostics queue', function () {
    it('should bound the diagnostics queue to 1MB', function () {
      const MAX_QUEUE_BYTES = 1024 * 1024
      let accepted = 0

      // Flush a status per upload interval, without ever completing the uploads, until the queue is full
      while (!guardrailMetrics.eventDropped.called) {
        assert.ok(accepted < 10_000, 'the queue should have filled up by now')
        statusproxy.ackReceived({ id: 'foo', version: accepted++ })
        clock.tick(1000)
      }

      sinon.assert.calledOnceWithExactly(
        guardrailMetrics.eventDropped, DROPPED_REASON.QUEUE_FULL, EVENT_TYPE.DIAGNOSTIC
      )
      sinon.assert.callCount(request, accepted - 1)
      assert.ok(jsonBuffer.queuedBytes <= MAX_QUEUE_BYTES, `Expected ${jsonBuffer.queuedBytes} <= ${MAX_QUEUE_BYTES}`)
      assert.ok(jsonBuffer.queuedBytes > MAX_QUEUE_BYTES - 1024, `Expected ${jsonBuffer.queuedBytes} to fill the queue`)
    })

    it('should release a payload from the queue once its upload completes', function () {
      statusproxy.ackReceived({ id: 'foo', version: 0 })
      clock.tick(1000)
      sinon.assert.calledOnce(request)
      assert.ok(jsonBuffer.queuedBytes > 0, `Expected ${jsonBuffer.queuedBytes} > 0`)

      request.lastCall.args[2](new Error('boom'))

      assert.strictEqual(jsonBuffer.queuedBytes, 0)
    })
  })

  it('should send directly to the debugger intake in agentless mode', function () {
    const requestAgentless = sinon.spy()
    requestAgentless['@noCallThru'] = true
    const proxyAgent = {}
    const getHttpsProxyAgent = sinon.stub().returns(proxyAgent)
    getHttpsProxyAgent['@noCallThru'] = true
    const requestOptions = proxyquire('../../../src/debugger/devtools_client/request-options', {
      '../../evp_proxy/direct': { getHttpsProxyAgent },
    })
    const statusAgentless = proxyquire('../../../src/debugger/devtools_client/status', {
      './config': {
        agentless: true,
        apiKey: 'test-api-key',
        inputPath: '/api/v2/debugger',
        service,
        runtimeId,
        url: new URL('https://debugger-intake.us3.datadoghq.com'),
        maxTotalPayloadSize: 5 * 1024 * 1024,
        dynamicInstrumentation: {
          uploadIntervalSeconds: 1,
        },
        '@noCallThru': true,
      },
      '../../exporters/common/request': requestAgentless,
      './request-options': requestOptions,
    })

    statusAgentless.ackReceived({ id: 'agentless-probe', version: 0 })
    clock.tick(1000)

    sinon.assert.calledOnce(requestAgentless)
    const options = getRequestOptions(requestAgentless)
    assert.match(options.path, /^\/api\/v2\/debugger\?ddtags=/)
    assert.match(options.path, /runtime_id%3Amy-runtime-id/)
    assert.strictEqual(options.url.href, 'https://debugger-intake.us3.datadoghq.com/')
    assert.strictEqual(options.headers['DD-API-KEY'], 'test-api-key')
    assert.strictEqual(options.headers['DD-EVP-ORIGIN'], 'agent-debugger')
    assert.strictEqual(options.agent, proxyAgent)
    sinon.assert.calledOnceWithExactly(getHttpsProxyAgent, 'https://debugger-intake.us3.datadoghq.com/')
  })
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
