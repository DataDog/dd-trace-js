'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')

const { Verbosity } = require('../../../../src/appsec/iast/telemetry/verbosity')
const Config = require('../../../../src/config')
const iast = require('../../../../src/appsec/iast')
const agent = require('../../../plugins/agent')
const axios = require('axios')
const { testInRequest } = require('../utils')

describe('Telemetry', () => {
  describe('unit test', () => {
    let defaultConfig
    let telemetryMetrics
    let iastTelemetry
    let telemetryLogs
    let initRequestNamespace
    let finalizeRequestNamespace

    beforeEach(() => {
      defaultConfig = {
        telemetry: {
          enabled: true,
          metrics: true
        }
      }

      telemetryLogs = {
        registerProvider: () => telemetryLogs,
        start: sinon.spy(),
        stop: sinon.spy()
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
        './log': telemetryLogs,
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

        expect(iastTelemetry.enabled).to.be.true
        expect(iastTelemetry.verbosity).to.be.equal(Verbosity.INFORMATION)
        expect(telemetryLogs.start).to.be.calledOnce
      })

      it('should NOT enable telemetry if verbosity is OFF', () => {
        const iastTelemetry = proxyquire('../../../../src/appsec/iast/telemetry', {
          './log': telemetryLogs,
          '../../../telemetry/metrics': telemetryMetrics
        })

        const telemetryConfig = { enabled: true, metrics: true }
        iastTelemetry.configure({
          telemetry: telemetryConfig
        }, 'OFF')

        expect(iastTelemetry.enabled).to.be.false
        expect(iastTelemetry.verbosity).to.be.equal(Verbosity.OFF)
        expect(telemetryMetrics.manager.set).to.not.be.called
        expect(telemetryLogs.start).to.be.calledOnce
      })

      it('should enable telemetry if metrics not enabled but DD_TELEMETRY_METRICS_ENABLED is undefined', () => {
        const origTelemetryMetricsEnabled = process.env.DD_TELEMETRY_METRICS_ENABLED

        delete process.env.DD_TELEMETRY_METRICS_ENABLED

        const telemetryConfig = { enabled: true, metrics: false }
        iastTelemetry.configure({
          telemetry: telemetryConfig
        })

        expect(iastTelemetry.enabled).to.be.true
        expect(iastTelemetry.verbosity).to.be.equal(Verbosity.INFORMATION)
        expect(telemetryMetrics.manager.set).to.be.calledOnce
        expect(telemetryLogs.start).to.be.calledOnce

        process.env.DD_TELEMETRY_METRICS_ENABLED = origTelemetryMetricsEnabled
      })

      it('should not enable telemetry if metrics not enabled but DD_TELEMETRY_METRICS_ENABLED is defined', () => {
        const origTelemetryMetricsEnabled = process.env.DD_TELEMETRY_METRICS_ENABLED

        process.env.DD_TELEMETRY_METRICS_ENABLED = 'false'

        const telemetryConfig = { enabled: true, metrics: false }
        iastTelemetry.configure({
          telemetry: telemetryConfig
        })

        expect(iastTelemetry.enabled).to.be.false
        expect(iastTelemetry.verbosity).to.be.equal(Verbosity.OFF)
        expect(telemetryMetrics.manager.set).to.not.be.called
        expect(telemetryLogs.start).to.be.calledOnce

        process.env.DD_TELEMETRY_METRICS_ENABLED = origTelemetryMetricsEnabled
      })
    })

    describe('stop', () => {
      it('should set enabled = false and unregister provider', () => {
        iastTelemetry.configure(defaultConfig)

        iastTelemetry.stop()
        expect(iastTelemetry.enabled).to.be.false
        expect(telemetryMetrics.manager.delete).to.be.calledOnce
        expect(telemetryLogs.stop).to.be.calledOnce
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
          './log': telemetryLogs,
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
          './log': telemetryLogs,
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
      const config = new Config()
      iast.enable(config)
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
          .use(traces => {
            expect(traces[0][0].metrics['_dd.iast.telemetry.executed.source.http_request_header']).to.be.equal(1)
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
          .use(traces => {
            expect(traces[0][0].metrics['_dd.iast.telemetry.executed.source.http_request_path']).to.be.equal(1)
          })
          .then(done)
          .catch(done)
        axios.get(`http://localhost:${config.port}/`).catch(done)
      })
    }
    testInRequest(app, tests)
  })
})
