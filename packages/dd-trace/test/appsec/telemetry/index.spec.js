'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')
const { Verbosity } = require('../../../src/appsec/telemetry/verbosity')
const { REQUEST_TAINTED, EXECUTED_SINK, INSTRUMENTED_PROPAGATION } = require('../../../src/appsec/iast/iast-metric')

const TAG_PREFIX = '_dd.instrumentation_telemetry_data.iast'

describe('Telemetry', () => {
  let defaultConfig
  let collector
  let telemetryMetrics
  let telemetryLogs
  let telemetry
  let logCollector

  beforeEach(() => {
    defaultConfig = {
      telemetry: {
        enabled: true,
        metrics: true
      }
    }

    collector = {
      init: sinon.spy(),
      getFromContext: (context) => context['collector'],
      GLOBAL: {
        merge: sinon.spy()
      },
      addValue: sinon.spy(),
      drain: sinon.spy()
    }

    telemetryMetrics = {
      registerProvider: () => telemetryMetrics,
      unregisterProvider: sinon.spy(),
      init: sinon.spy(),
      stop: sinon.spy()
    }

    telemetryLogs = {
      registerProvider: () => telemetryLogs,
      init: sinon.spy(),
      stop: sinon.spy()
    }

    logCollector = require('../../../src/appsec/telemetry/log-collector')
    sinon.stub(logCollector, 'init')
    sinon.stub(logCollector, 'add')

    telemetry = proxyquire('../../../src/appsec/telemetry', {
      './telemetry-collector': collector,
      './api/metrics-plugin': telemetryMetrics,
      './api/logs-plugin': telemetryLogs,
      './log-collector': logCollector
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('configure', () => {
    it('should set default verbosity', () => {
      telemetry.configure(defaultConfig)

      expect(telemetry.enabled).to.be.true
      expect(telemetry.verbosity).to.be.eq(Verbosity.INFORMATION)
      expect(telemetryMetrics.init).to.be.calledOnceWith(defaultConfig.telemetry)
      expect(telemetryLogs.init).to.be.calledOnceWith(defaultConfig.telemetry)
    })

    it('should set OFF verbosity if not enabled', () => {
      defaultConfig.telemetry.enabled = false
      telemetry.configure(defaultConfig)

      expect(telemetry.enabled).to.be.false
      expect(telemetry.verbosity).to.be.eq(Verbosity.OFF)
      expect(telemetryMetrics.init).to.not.be.called
      expect(telemetryLogs.init).to.not.be.called
    })

    it('should init metrics even if verbosity is OFF', () => {
      const telemetry = proxyquire('../../../src/appsec/telemetry', {
        './telemetry-collector': collector,
        './api/metrics-plugin': telemetryMetrics,
        './api/logs-plugin': telemetryLogs,
        './log-collector': logCollector,
        './verbosity': {
          getVerbosity: () => Verbosity.OFF
        }
      })

      const telemetryConfig = { enabled: true, metrics: true }
      telemetry.configure({
        telemetry: telemetryConfig
      })

      expect(telemetry.enabled).to.be.true
      expect(telemetry.verbosity).to.be.eq(Verbosity.OFF)
      expect(telemetryMetrics.init).to.be.calledOnceWith(telemetryConfig)
      expect(telemetryLogs.init).to.be.calledOnceWith(telemetryConfig)
    })

    it('should not init metrics if metrics not enabled', () => {
      const telemetryConfig = { enabled: true, metrics: false }
      telemetry.configure({
        telemetry: telemetryConfig
      })

      expect(telemetry.enabled).to.be.false
      expect(telemetry.verbosity).to.be.eq(Verbosity.OFF)
      expect(telemetryMetrics.init).to.not.be.called
      expect(telemetryLogs.init).to.not.be.called
    })
  })

  describe('stop', () => {
    it('should set enabled = false and unregister provider', () => {
      telemetry.configure(defaultConfig)

      telemetry.stop()
      expect(telemetry.enabled).to.be.false
      expect(telemetryMetrics.stop).to.be.calledOnce
      expect(telemetryLogs.stop).to.be.calledOnce
    })
  })

  describe('onRequestStarted', () => {
    it('should call init if enabled and verbosity is not Off', () => {
      telemetry.configure(defaultConfig)

      const iastContext = {}
      telemetry.onRequestStarted(iastContext)

      expect(collector.init).to.be.calledOnceWith(iastContext)
    })

    it('should not call init if enabled and verbosity is Off', () => {
      const telemetry = proxyquire('../../../src/appsec/telemetry', {
        './telemetry-collector': collector,
        './api/metrics-plugin': telemetryMetrics,
        './api/logs-plugin': telemetryLogs,
        './log-collector': logCollector,
        './verbosity': {
          getVerbosity: () => Verbosity.OFF
        }
      })
      telemetry.configure({
        telemetry: { enabled: true }
      })

      const iastContext = {}
      telemetry.onRequestStarted(iastContext)

      expect(collector.init).to.not.be.calledOnce
    })
  })

  describe('onRequestEnded', () => {
    let iastContext
    let rootSpan

    beforeEach(() => {
      telemetry.configure(defaultConfig)

      rootSpan = {
        addTags: sinon.spy()
      }
    })

    it('should set a rootSpan tag with the flattened value of the metric', () => {
      const metrics = [{
        metric: REQUEST_TAINTED,
        points: [{ value: 5 }, { value: 5 }]
      }]

      iastContext = {
        collector: {
          drainMetrics: sinon.stub().returns(metrics)
        }
      }

      telemetry.onRequestEnded(iastContext, rootSpan, TAG_PREFIX)

      expect(iastContext.collector.drainMetrics).to.be.calledOnce
      expect(rootSpan.addTags).to.be.called

      const tag = rootSpan.addTags.getCalls()[0].args[0]
      expect(tag).to.has.property(`${TAG_PREFIX}.${REQUEST_TAINTED.name}`)
      expect(tag[`${TAG_PREFIX}.${REQUEST_TAINTED.name}`]).to.be.eq(10)
    })

    it('should set as many rootSpan tags as different request scoped metrics', () => {
      const metrics = [{
        metric: REQUEST_TAINTED,
        points: [{ value: 5 }, { value: 5 }]
      },
      {
        metric: EXECUTED_SINK,
        points: [{ value: 1 }]
      },
      {
        metric: REQUEST_TAINTED,
        points: [{ value: 5 }]
      }]

      iastContext = {
        collector: {
          drainMetrics: sinon.stub().returns(metrics)
        }
      }

      telemetry.onRequestEnded(iastContext, rootSpan, TAG_PREFIX)

      expect(iastContext.collector.drainMetrics).to.be.calledOnce
      expect(rootSpan.addTags).to.be.calledTwice

      const calls = rootSpan.addTags.getCalls()
      const reqTaintedTag = calls[0].args[0]
      expect(reqTaintedTag).to.has.property(`${TAG_PREFIX}.${REQUEST_TAINTED.name}`)
      expect(reqTaintedTag[`${TAG_PREFIX}.${REQUEST_TAINTED.name}`]).to.be.eq(15)

      const execSinkTag = calls[1].args[0]
      expect(execSinkTag).to.has.property(`${TAG_PREFIX}.${EXECUTED_SINK.name}`)
      expect(execSinkTag[`${TAG_PREFIX}.${EXECUTED_SINK.name}`]).to.be.eq(1)
    })

    it('should set filter out global scoped metrics', () => {
      const metrics = [{
        metric: INSTRUMENTED_PROPAGATION,
        points: [{ value: 5 }, { value: 5 }]
      }]

      iastContext = {
        collector: {
          drainMetrics: sinon.stub().returns(metrics)
        }
      }

      telemetry.onRequestEnded(iastContext, rootSpan)

      expect(iastContext.collector.drainMetrics).to.be.calledOnce
      expect(rootSpan.addTags).to.not.be.called
    })

    it('should merge all kind of metrics in GLOBAL collector', () => {
      const metrics = [{
        metric: REQUEST_TAINTED,
        points: [{ value: 5 }, { value: 5 }]
      },
      {
        metric: INSTRUMENTED_PROPAGATION,
        points: [{ value: 1 }]
      }]

      iastContext = {
        collector: {
          drainMetrics: sinon.stub().returns(metrics)
        }
      }

      telemetry.onRequestEnded(iastContext, rootSpan)
      expect(collector.GLOBAL.merge).to.be.calledWith(metrics)
    })

    it('should not fail with incomplete metrics', () => {
      const metrics = [{
        points: [{ value: 5 }, { value: 5 }]
      },
      {
        metric: INSTRUMENTED_PROPAGATION
      },
      {}]

      iastContext = {
        collector: {
          drainMetrics: sinon.stub().returns(metrics)
        }
      }

      telemetry.onRequestEnded(iastContext, rootSpan)
      expect(collector.GLOBAL.merge).to.be.calledWith(metrics)
    })
  })
})
