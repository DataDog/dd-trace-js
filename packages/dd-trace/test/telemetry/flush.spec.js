'use strict'

const { describe, it } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noPreserveCache()

require('../setup/core')

describe('instrumentation telemetry flush', () => {
  it('continues draining buffered sources when one source fails before joining requests', () => {
    const flushError = null
    const dependencies = {
      flush: sinon.stub().callsFake(() => { throw flushError }),
      start: sinon.spy(),
    }
    const endpoints = { flush: sinon.spy(), start: sinon.spy() }
    const flushRequests = sinon.stub().callsFake(done => done())
    const log = { error: sinon.stub(), trace: sinon.stub(), warn: sinon.stub() }
    const metricsManager = { send: sinon.spy() }
    const registerFlusher = sinon.spy()
    const telemetryLogger = { send: sinon.spy(), start: sinon.spy() }
    const telemetry = proxyquire('../../src/telemetry/telemetry', {
      '../flush': { registerFlusher },
      '../log': log,
      './dependencies': dependencies,
      './endpoints': endpoints,
      './logs': telemetryLogger,
      './metrics': { manager: metricsManager },
      './send-data': { flush: flushRequests, sendData: sinon.spy() },
      './session-propagation': { start: sinon.spy() },
    })
    const config = {
      appsec: { enabled: false, DD_APPSEC_SCA_ENABLED: false },
      profiling: { DD_PROFILING_ENABLED: 'false' },
      service: 'service',
      tags: { 'runtime-id': 'runtime-id' },
      telemetry: {
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: true,
        DD_TELEMETRY_EXTENDED_HEARTBEAT_INTERVAL: 86_400_000,
        DD_TELEMETRY_HEARTBEAT_INTERVAL: 60_000,
      },
    }
    const done = sinon.spy()

    telemetry.start(config, { _pluginsByName: {} })
    const flusher = registerFlusher.firstCall.args[1]
    flusher(done)

    sinon.assert.calledOnce(dependencies.flush)
    sinon.assert.calledOnce(endpoints.flush)
    sinon.assert.calledOnceWithExactly(metricsManager.send, config, sinon.match.object, sinon.match.object)
    sinon.assert.calledOnceWithExactly(telemetryLogger.send, config, sinon.match.object, sinon.match.object)
    sinon.assert.calledOnceWithExactly(flushRequests, done)
    sinon.assert.calledOnceWithExactly(log.error, 'Failed to flush instrumentation telemetry: %s', flushError)
    sinon.assert.calledOnce(done)
  })
})
