'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')
const { Verbosity } = require('../../../../src/appsec/iast/telemetry/verbosity')

describe('Telemetry', () => {
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
      expect(iastTelemetry.verbosity).to.be.eq(Verbosity.INFORMATION)
      expect(telemetryLogs.start).to.be.calledOnce
    })

    it('should set OFF verbosity if not enabled', () => {
      defaultConfig.telemetry.enabled = false
      iastTelemetry.configure(defaultConfig)

      expect(iastTelemetry.enabled).to.be.false
      expect(iastTelemetry.verbosity).to.be.eq(Verbosity.OFF)
      expect(telemetryLogs.start).to.be.called
    })

    it('should init metrics even if verbosity is OFF', () => {
      const iastTelemetry = proxyquire('../../../../src/appsec/iast/telemetry', {
        './log': telemetryLogs,
        '../../../telemetry/metrics': telemetryMetrics,
        './verbosity': {
          getVerbosity: () => Verbosity.OFF
        }
      })

      const telemetryConfig = { enabled: true, metrics: true }
      iastTelemetry.configure({
        telemetry: telemetryConfig
      })

      expect(iastTelemetry.enabled).to.be.true
      expect(iastTelemetry.verbosity).to.be.eq(Verbosity.OFF)
      expect(telemetryMetrics.manager.set).to.be.calledOnce
      expect(telemetryLogs.start).to.be.calledOnce
    })

    it('should not init metrics if metrics not enabled', () => {
      const telemetryConfig = { enabled: true, metrics: false }
      iastTelemetry.configure({
        telemetry: telemetryConfig
      })

      expect(iastTelemetry.enabled).to.be.false
      expect(iastTelemetry.verbosity).to.be.eq(Verbosity.OFF)
      expect(telemetryMetrics.manager.set).to.not.be.called
      expect(telemetryLogs.start).to.be.calledOnce
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

  describe('onRequestStarted', () => {
    it('should call init if enabled and verbosity is not Off', () => {
      iastTelemetry.configure(defaultConfig)

      const iastContext = {}
      iastTelemetry.onRequestStarted(iastContext)

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
      iastTelemetry.onRequestStarted(iastContext)

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
