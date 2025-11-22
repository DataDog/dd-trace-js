'use strict'

const assert = require('node:assert/strict')

const axios = require('axios')
const { expect } = require('chai')
const { after, afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const iast = require('../../../../src/appsec/iast')
const { Verbosity } = require('../../../../src/appsec/iast/telemetry/verbosity')
const { getConfigFresh } = require('../../../helpers/config')
const agent = require('../../../plugins/agent')
const { testInRequest } = require('../utils')

describe('Telemetry', () => {
  describe('unit test', () => {
    let defaultConfig
    let telemetryMetrics
    let iastTelemetry
    let initRequestNamespace
    let finalizeRequestNamespace

    beforeEach(() => {
      defaultConfig = {
        telemetry: {
          enabled: true,
          metrics: true
        }
      }

      telemetryMetrics = {
        manager: {
          set: sinon.spy(),
          delete: sinon.spy()
        }
      }

      initRequestNamespace = sinon.spy()
      finalizeRequestNamespace = sinon.spy()

      iastTelemetry = proxyquire('../../../../src/appsec/iast/telemetry', {
        '../../../telemetry/metrics': telemetryMetrics,
        './namespaces': {
          initRequestNamespace,
          finalizeRequestNamespace
        }
      })
    })

    afterEach(() => {
      sinon.restore()
    })

    describe('configure', () => {
      it('should set default verbosity', () => {
        iastTelemetry.configure(defaultConfig)

        assert.strictEqual(iastTelemetry.enabled, true)
        assert.strictEqual(iastTelemetry.verbosity, Verbosity.INFORMATION)
      })

      it('should not enable telemetry if verbosity is OFF', () => {
        const iastTelemetry = proxyquire('../../../../src/appsec/iast/telemetry', {
          '../../../telemetry/metrics': telemetryMetrics
        })

        const telemetryConfig = { enabled: true, metrics: true }
        iastTelemetry.configure({
          telemetry: telemetryConfig
        }, 'OFF')

        assert.strictEqual(iastTelemetry.enabled, false)
        assert.strictEqual(iastTelemetry.verbosity, Verbosity.OFF)
        expect(telemetryMetrics.manager.set).to.not.be.called
      })

      it('should enable telemetry if telemetry.metrics is true', () => {
        const telemetryConfig = { enabled: true, metrics: true }
        iastTelemetry.configure({
          telemetry: telemetryConfig
        })

        assert.strictEqual(iastTelemetry.enabled, true)
        assert.strictEqual(iastTelemetry.verbosity, Verbosity.INFORMATION)
        sinon.assert.calledOnce(telemetryMetrics.manager.set)
      })

      it('should not enable telemetry if telemetry.metrics is false', () => {
        const telemetryConfig = { enabled: true, metrics: false }
        iastTelemetry.configure({
          telemetry: telemetryConfig
        })

        assert.strictEqual(iastTelemetry.enabled, false)
        assert.strictEqual(iastTelemetry.verbosity, Verbosity.OFF)
        expect(telemetryMetrics.manager.set).to.not.be.called
      })
    })

    describe('stop', () => {
      it('should set enabled = false and unregister provider', () => {
        iastTelemetry.configure(defaultConfig)

        iastTelemetry.stop()
        assert.strictEqual(iastTelemetry.enabled, false)
        sinon.assert.calledOnce(telemetryMetrics.manager.delete)
      })
    })

    describe('onRequestStart', () => {
      it('should call init if enabled and verbosity is not Off', () => {
        iastTelemetry.configure(defaultConfig)

        const iastContext = {}
        iastTelemetry.onRequestStart(iastContext)

        expect(initRequestNamespace).to.be.calledOnceWith(iastContext)
      })

      it('should not call init if enabled and verbosity is Off', () => {
        const iastTelemetry = proxyquire('../../../../src/appsec/iast/telemetry', {
          '../../../telemetry/metrics': telemetryMetrics,
          './verbosity': {
            getVerbosity: () => Verbosity.OFF
          }
        })
        iastTelemetry.configure({
          telemetry: { enabled: true }
        })

        const iastContext = {}
        iastTelemetry.onRequestStart(iastContext)

        expect(initRequestNamespace).to.not.be.calledOnce
      })
    })

    describe('onRequestEnd', () => {
      it('should call finalizeRequestNamespace if enabled and verbosity is not Off', () => {
        iastTelemetry.configure(defaultConfig)

        const iastContext = {}
        iastTelemetry.onRequestEnd(iastContext)

        expect(finalizeRequestNamespace).to.be.calledOnceWith(iastContext)
      })

      it('should not call finalizeRequestNamespace if enabled and verbosity is Off', () => {
        const iastTelemetry = proxyquire('../../../../src/appsec/iast/telemetry', {
          '../../../telemetry/metrics': telemetryMetrics,
          './verbosity': {
            getVerbosity: () => Verbosity.OFF
          }
        })
        iastTelemetry.configure({
          telemetry: { enabled: true }
        })

        const iastContext = {}
        iastTelemetry.onRequestEnd(iastContext)

        expect(finalizeRequestNamespace).to.not.be.calledOnce
      })
    })
  })

  describe('full feature', () => {
    let originalProcessEnv

    beforeEach(() => {
      originalProcessEnv = process.env
      process.env = {
        DD_TELEMETRY_METRICS_ENABLED: 'true',
        DD_IAST_ENABLED: 'true',
        DD_IAST_REQUEST_SAMPLING: '100'
      }
      iast.enable(getConfigFresh())
    })

    afterEach(() => {
      iast.disable()
      process.env = originalProcessEnv
    })

    after(() => {
      process.env = originalProcessEnv
    })
    function app () {}

    function tests (config) {
      it('should have header source execution metric', (done) => {
        agent
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].metrics['_dd.iast.telemetry.executed.source.http_request_header'], 1)
          })
          .then(done)
          .catch(done)
        axios.get(`http://localhost:${config.port}/`, {
          headers: {
            'x-test-header': 'test-value'
          }
        }).catch(done)
      })

      it('should have url source execution metric', (done) => {
        agent
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].metrics['_dd.iast.telemetry.executed.source.http_request_uri'], 1)
          })
          .then(done)
          .catch(done)
        axios.get(`http://localhost:${config.port}/`).catch(done)
      })
    }
    testInRequest(app, tests)
  })
})
