'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')
const { INSTRUMENTED_PROPAGATION, INSTRUMENTED_SOURCE,
  REQUEST_TAINTED } = require('../../../src/appsec/iast/iast-metric')
const { addValue, getMetricCollector, init, getFromContext, drain
  , DD_TELEMETRY_COLLECTOR, GLOBAL
  , TelemetryCollector } =
  require('../../../src/appsec/telemetry/telemetry-collector')

function getHandler (metric) {
  return getMetricCollector(metric).handlers.get(metric)
}

describe('IAST TelemetryCollector', () => {
  beforeEach(() => {
    getMetricCollector(INSTRUMENTED_PROPAGATION).reset()
  })

  describe('TelemetryCollector', () => {
    let testHandler
    let otherHandler
    beforeEach(() => {
      testHandler = {
        add: sinon.spy(),
        drain: sinon.spy(),
        merge: sinon.spy()
      }
      otherHandler = {
        add: sinon.spy(),
        drain: sinon.spy(),
        merge: sinon.spy()
      }
    })

    describe('getOrCreateHandler', () => {
      it('should apply builder', () => {
        const testHandler = {}
        const otherHandler = {}
        const collector = new TelemetryCollector((metric) => metric.name === 'test' ? testHandler : otherHandler)

        const metric = { name: 'test' }
        const handler = collector.getOrCreateHandler(metric)

        expect(handler).to.be.equal(testHandler)
        expect(collector.handlers.size).to.be.eq(1)
        expect(collector.handlers.has(metric)).to.be.true

        collector.getOrCreateHandler(metric)
        expect(collector.handlers.size).to.be.eq(1)

        const otherMetric = { name: 'other' }
        const handler2 = collector.getOrCreateHandler(otherMetric)

        expect(handler2).to.be.equal(otherHandler)
        expect(collector.handlers.size).to.be.eq(2)
        expect(collector.handlers.has(otherMetric)).to.be.true
      })

      it('should reuse created handlers', () => {
        const testHandler = {}
        const otherHandler = {}
        const collector = new TelemetryCollector((metric) => metric.name === 'test' ? testHandler : otherHandler)

        const metric = { name: 'test' }
        collector.getOrCreateHandler(metric)
        collector.getOrCreateHandler(metric)
        collector.getOrCreateHandler(metric)

        expect(collector.handlers.size).to.be.eq(1)
        expect(collector.handlers.has(metric)).to.be.true
      })
    })

    describe('addMetric', () => {
      it('should add metric to right handler', () => {
        const collector = new TelemetryCollector((metric) => metric.name === 'test' ? testHandler : otherHandler)

        const metric = { name: 'test' }
        const otherMetric = { name: 'other' }
        collector.addMetric(metric, 5, 'tag1')
        collector.addMetric(otherMetric, 10, 'tag2')

        expect(testHandler.add).to.be.calledOnceWith(5, 'tag1')
        expect(otherHandler.add).to.be.calledOnceWith(10, 'tag2')
      })
    })

    describe('drainMetrics', () => {
      it('should drain all handlers', () => {
        const collector = new TelemetryCollector((metric) => metric.name === 'test' ? testHandler : otherHandler)

        const metric = { name: 'test' }
        const otherMetric = { name: 'other' }
        collector.addMetric(metric, 5)
        collector.addMetric(otherMetric, 5)

        collector.drainMetrics()

        expect(testHandler.drain).to.be.calledOnce
        expect(otherHandler.drain).to.be.calledOnce
        expect(collector.handlers.size).to.be.eq(0)
      })
    })

    describe('merge', () => {
      it('should merge all handlers even if not built before', () => {
        const collector = new TelemetryCollector((metric) => metric.name === 'test' ? testHandler : otherHandler)

        const metric = { name: 'test' }
        collector.addMetric(metric, 5)

        collector.merge([
          { metric: { name: 'test' } },
          { metric: { name: 'test' } },
          { metric: { name: 'other' } }
        ])

        expect(testHandler.merge).to.be.calledTwice
        expect(otherHandler.merge).to.be.calledOnce
      })
    })
  })

  describe('add', () => {
    function inc (metric, tag, context) {
      return addValue(metric, 1, tag, context)
    }

    it('should increment a conflated metric', () => {
      inc(INSTRUMENTED_PROPAGATION)

      const handler = getHandler(INSTRUMENTED_PROPAGATION)

      let metricDataList = handler.drain()
      expect(metricDataList.length).to.be.eq(1)
      expect(metricDataList[0].points.length).to.be.eq(1)
      expect(metricDataList[0].points[0].value).to.be.eq(1)

      metricDataList = handler.drain()
      expect(metricDataList.length).to.be.eq(0)
    })

    it('should increment a conflated metric every time it is called', () => {
      inc(INSTRUMENTED_PROPAGATION)
      inc(INSTRUMENTED_PROPAGATION)
      inc(INSTRUMENTED_PROPAGATION)

      const handler = getHandler(INSTRUMENTED_PROPAGATION)

      let metricDataList = handler.drain()
      expect(metricDataList.length).to.be.eq(1)
      expect(metricDataList[0].points.length).to.be.eq(1)
      expect(metricDataList[0].points[0].value).to.be.eq(3)

      metricDataList = handler.drain()
      expect(metricDataList.length).to.be.eq(0)
    })

    it('should increment a conflated tagged metric', () => {
      inc(INSTRUMENTED_SOURCE, 'tag1')

      const handler = getHandler(INSTRUMENTED_SOURCE)

      let metricDataList = handler.drain()
      expect(metricDataList.length).to.be.eq(1)

      expect(metricDataList.length).to.be.eq(1)
      expect(metricDataList[0].tag).to.be.eq('tag1')
      expect(metricDataList[0].points.length).to.be.eq(1)
      expect(metricDataList[0].points[0].value).to.be.eq(1)

      metricDataList = handler.drain()
      expect(metricDataList.length).to.be.eq(0)
    })

    it('should increment a conflated tagged metric every time is called', () => {
      inc(INSTRUMENTED_SOURCE, 'tag1')
      inc(INSTRUMENTED_SOURCE, 'tag1')
      inc(INSTRUMENTED_SOURCE, 'tag1')

      const handler = getHandler(INSTRUMENTED_SOURCE)

      let metricDataList = handler.drain()
      expect(metricDataList.length).to.be.eq(1)

      expect(metricDataList.length).to.be.eq(1)
      expect(metricDataList[0].tag).to.be.eq('tag1')
      expect(metricDataList[0].points.length).to.be.eq(1)
      expect(metricDataList[0].points[0].value).to.be.eq(3)

      metricDataList = handler.drain()
      expect(metricDataList.length).to.be.eq(0)
    })

    it('should increment an aggregated metric', () => {
      inc(REQUEST_TAINTED)
      inc(REQUEST_TAINTED)

      const handler = getHandler(REQUEST_TAINTED)

      let metricDataList = handler.drain()
      expect(metricDataList.length).to.be.eq(1)
      expect(metricDataList[0].points.length).to.be.eq(2)

      metricDataList = handler.drain()
      expect(metricDataList.length).to.be.eq(1)
      expect(metricDataList[0].points.length).to.be.eq(0)
    })

    it('should add any value to a conflated metric', () => {
      inc(INSTRUMENTED_SOURCE, 'tag1')
      addValue(INSTRUMENTED_SOURCE, 5, 'tag1')

      const handler = getHandler(INSTRUMENTED_SOURCE)
      const metricDataList = handler.drain()
      expect(metricDataList.length).to.be.eq(1)
      expect(metricDataList[0].points.length).to.be.eq(1)
      expect(metricDataList[0].points[0].value).to.be.eq(6)
    })

    it('should add any value to an aggregated metric', () => {
      inc(REQUEST_TAINTED)
      addValue(REQUEST_TAINTED, 5)

      const handler = getHandler(REQUEST_TAINTED)
      const metricDataList = handler.drain()
      expect(metricDataList.length).to.be.eq(1)
      expect(metricDataList[0].points.length).to.be.eq(2)
      expect(metricDataList[0].points[0].value).to.be.eq(1)
      expect(metricDataList[0].points[1].value).to.be.eq(5)
    })

    it('should catch exceptions', () => {
      const logError = sinon.stub()
      const { addValue } = proxyquire('../../../src/appsec/telemetry/telemetry-collector', {
        '../../log': {
          error: logError
        }
      })

      const error = new Error('Error')
      const evilMetric = {
        hasRequestScope: () => { throw error }
      }

      expect(addValue(evilMetric, 5)).to.not.throw
      expect(logError).to.be.calledOnceWith(error)
    })
  })

  describe('init', () => {
    it('should create a TelemetryCollector instance', () => {
      const context = {}
      const collector = init(context)

      expect(collector).to.not.be.undefined
      expect(context[DD_TELEMETRY_COLLECTOR]).to.not.be.undefined

      expect(collector).to.be.eq(getFromContext(context))
    })
  })

  describe('getFromContext', () => {
    it('should return a TelemetryCollector instance and remove it from context if deleteCollector is specified', () => {
      const context = {}
      const collector = init(context)

      expect(collector).to.not.be.undefined
      expect(context[DD_TELEMETRY_COLLECTOR]).to.not.be.undefined

      expect(collector).to.be.eq(getFromContext(context, true))
      expect(context[DD_TELEMETRY_COLLECTOR]).to.be.undefined
      expect(getFromContext(context)).to.be.undefined
    })
  })

  describe('getMetricCollector', () => {
    it('should return a request initialized collector for a request metric', () => {
      const context = {}
      const collector = init(context)

      const reqMetricCollector = getMetricCollector(REQUEST_TAINTED, context)

      expect(reqMetricCollector).to.be.eq(collector)
    })

    // TODO: at the moment, if no context is provided for a request scoped metric GLOBAL collector is returned
    it('should return GLOBAL collector for a request metric if not context is provided?', () => {
      const context = {}
      init(context)

      const reqMetricCollector = getMetricCollector(REQUEST_TAINTED)

      expect(reqMetricCollector).to.be.eq(GLOBAL)
    })

    it('should return GLOBAL collector for a global metric', () => {
      const context = {}
      const collector = init(context)

      const globalMetricCollector = getMetricCollector(INSTRUMENTED_PROPAGATION, context)

      expect(globalMetricCollector).to.be.eq(GLOBAL)
      expect(globalMetricCollector).to.be.not.eq(collector)
    })
  })

  describe('drain', () => {
    it('should drain GLOBAL metrics', () => {
      GLOBAL.addMetric(INSTRUMENTED_SOURCE, 5, 'http.request.param')
      GLOBAL.addMetric(INSTRUMENTED_SOURCE, 5, 'http.request.param')

      // same metric with different tag
      GLOBAL.addMetric(INSTRUMENTED_SOURCE, 1, 'http.request.body')

      GLOBAL.addMetric(REQUEST_TAINTED, 15)
      GLOBAL.addMetric(REQUEST_TAINTED, 20)

      const drained = drain()
      expect(drained.length).to.be.eq(3)

      // conflated
      const sourceParam = drained[0]
      expect(sourceParam.metric).to.be.eq('instrumented.source')
      expect(sourceParam.tags).to.be.deep.eq(['source_type:http.request.param'])
      expect(sourceParam.common).to.be.eq(true)
      expect(sourceParam.type).to.be.eq('count')

      // only one point with the sum
      expect(sourceParam.points.length).to.be.eq(1)
      expect(sourceParam.points[0]).to.be.an.instanceOf(Array)
      expect(sourceParam.points[0].length).to.be.eq(2)
      expect(sourceParam.points[0][1]).to.be.eq(10)

      // conflated with other tag
      const sourceBody = drained[1]
      expect(sourceBody.metric).to.be.eq('instrumented.source')
      expect(sourceBody.tags).to.be.deep.eq(['source_type:http.request.body'])
      expect(sourceBody.common).to.be.eq(true)
      expect(sourceBody.type).to.be.eq('count')

      // only one point with the sum
      expect(sourceBody.points.length).to.be.eq(1)
      expect(sourceBody.points[0]).to.be.an.instanceOf(Array)
      expect(sourceBody.points[0].length).to.be.eq(2)
      expect(sourceBody.points[0][1]).to.be.eq(1)

      // aggregated
      const requestTainted = drained[2]
      expect(requestTainted.metric).to.be.eq('request.tainted')
      expect(requestTainted.tags).to.be.undefined
      expect(requestTainted.common).to.be.eq(true)
      expect(requestTainted.type).to.be.eq('count')

      // as many points as added metrics
      expect(requestTainted.points.length).to.be.eq(2)
      expect(requestTainted.points[0]).to.be.an.instanceOf(Array)
      expect(requestTainted.points[0].length).to.be.eq(2)
      expect(requestTainted.points[0][1]).to.be.eq(15)
      expect(requestTainted.points[1][1]).to.be.eq(20)
    })
  })
})
