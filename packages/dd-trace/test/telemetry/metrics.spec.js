'use strict'

require('../setup/tap')

const proxyquire = require('proxyquire')

describe('metrics', () => {
  let metrics
  let sendData
  let now

  beforeEach(() => {
    now = Date.now()
    sinon.stub(Date, 'now').returns(now)

    sendData = sinon.stub()
    metrics = proxyquire('../../src/telemetry/metrics', {
      './send-data': {
        sendData
      }
    })
  })

  afterEach(() => {
    Date.now.restore()
  })

  describe('NamespaceManager', () => {
    it('should export singleton manager', () => {
      expect(metrics.manager).to.be.instanceOf(metrics.NamespaceManager)
    })

    it('should make namespaces', () => {
      const manager = new metrics.NamespaceManager()
      const ns = manager.namespace('test')
      expect(ns).to.be.instanceOf(metrics.Namespace)
      expect(ns.namespace).to.equal('test')
      expect(ns.toString()).to.equal('dd.instrumentation_telemetry_data.test')
    })

    it('should reuse namespace instances with the same name', () => {
      const manager = new metrics.NamespaceManager()
      const ns = manager.namespace('test')
      expect(manager.namespace('test')).to.equal(ns)
    })

    it('should convert to json', () => {
      const manager = new metrics.NamespaceManager()

      const test1 = manager.namespace('test1')
      const test2 = manager.namespace('test2')

      test1.count('metric1', { bar: 'baz' }).inc()
      test2.count('metric2', { bux: 'bax' }).inc()

      expect(manager.toJSON()).to.deep.equal([
        {
          namespace: 'test1',
          series: [
            {
              metric: 'metric1',
              points: [[now / 1e3, 1]],
              interval: undefined,
              type: 'count',
              tags: [
                'bar:baz',
                'lib_language:nodejs',
                `version:${process.version}`
              ],
              common: true
            }
          ]
        },
        {
          namespace: 'test2',
          series: [
            {
              metric: 'metric2',
              points: [[now / 1e3, 1]],
              interval: undefined,
              type: 'count',
              tags: [
                'bux:bax',
                'lib_language:nodejs',
                `version:${process.version}`
              ],
              common: true
            }
          ]
        }
      ])
    })

    it('should send data', () => {
      const manager = new metrics.NamespaceManager()

      const test1 = manager.namespace('test1')
      const test2 = manager.namespace('test2')

      test1.count('metric1', { bar: 'baz' }).inc()
      test2.count('metric2', { bux: 'bax' }).inc()

      const config = {
        hostname: 'localhost',
        port: 12345,
        tags: {
          'runtime-id': 'abc123'
        }
      }
      const application = {
        language_name: 'nodejs',
        tracer_version: '1.2.3'
      }
      const host = {}

      manager.send(config, application, host)

      expect(sendData).to.have.been
        .calledWith(config, application, host, 'generate-metrics', {
          namespace: 'test1',
          series: [
            {
              metric: 'metric1',
              points: [[now / 1e3, 1]],
              interval: undefined,
              type: 'count',
              tags: [
                'bar:baz',
                'lib_language:nodejs',
                `version:${process.version}`
              ],
              common: true
            }
          ]
        })
      expect(sendData).to.have.been
        .calledWith(config, application, host, 'generate-metrics', {
          namespace: 'test2',
          series: [
            {
              metric: 'metric2',
              points: [[now / 1e3, 1]],
              interval: undefined,
              type: 'count',
              tags: [
                'bux:bax',
                'lib_language:nodejs',
                `version:${process.version}`
              ],
              common: true
            }
          ]
        })
    })
  })

  describe('Namespace', () => {
    it('should store namespace name', () => {
      const ns = new metrics.Namespace('name')
      expect(ns).to.have.property('namespace', 'name')
    })

    it('should convert to string', () => {
      const ns = new metrics.Namespace('name')
      expect(ns.toString()).to.equal('dd.instrumentation_telemetry_data.name')
    })

    it('should get count metric', () => {
      const ns = new metrics.Namespace('name')
      expect(ns.count('name')).to.be.instanceOf(metrics.CountMetric)
    })

    it('should get gauge metric', () => {
      const ns = new metrics.Namespace('name')
      expect(ns.gauge('name')).to.be.instanceOf(metrics.GaugeMetric)
    })

    it('should get rate metric', () => {
      const ns = new metrics.Namespace('name')
      expect(ns.rate('name')).to.be.instanceOf(metrics.RateMetric)
    })

    it('should get metric by type', () => {
      const ns = new metrics.Namespace('name')
      expect(ns.getMetric('count', 'name')).to.be.instanceOf(metrics.CountMetric)
      expect(ns.getMetric('gauge', 'name')).to.be.instanceOf(metrics.GaugeMetric)
      expect(ns.getMetric('rate', 'name')).to.be.instanceOf(metrics.RateMetric)

      expect(() => ns.getMetric('non-existent', 'name'))
        .to.throw(Error, 'Unknown metric type non-existent')
    })

    it('should have unique metrics per unique tag set', () => {
      const ns = new metrics.Namespace('test')
      ns.count('foo', { bar: 'baz' }).inc()
      ns.count('foo', { bar: 'baz' }).inc() // not unique
      ns.count('foo', { bux: 'bax' }).inc()
      expect(ns).to.have.lengthOf(2)
    })

    it('should reset metrics', () => {
      const ns = new metrics.Namespace('test')
      const metric = ns.count('foo', { bar: 'baz' })
      metric.inc()

      metric.reset = sinon.spy(metric.reset)

      expect(metric.points).to.have.lengthOf(1)
      ns.reset()
      expect(metric.points).to.have.lengthOf(0)

      expect(metric.reset).to.have.been.called
    })

    it('should convert to json', () => {
      const ns = new metrics.Namespace('test')
      ns.count('foo', { bar: 'baz' }).inc()
      ns.count('foo', { bux: 'bax' }).inc()

      expect(ns.toJSON()).to.deep.equal({
        namespace: 'test',
        series: [
          {
            metric: 'foo',
            points: [[now / 1e3, 1]],
            interval: undefined,
            type: 'count',
            tags: [
              'bar:baz',
              'lib_language:nodejs',
              `version:${process.version}`
            ],
            common: true
          },
          {
            metric: 'foo',
            points: [[now / 1e3, 1]],
            interval: undefined,
            type: 'count',
            tags: [
              'bux:bax',
              'lib_language:nodejs',
              `version:${process.version}`
            ],
            common: true
          }
        ]
      })
    })
  })

  describe('CountMetric', () => {
    it('should expose input data', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.count('name', {
        foo: 'bar',
        baz: 'buz'
      })

      expect(metric.type).to.equal('count')
      expect(metric).to.deep.equal({
        namespace: 'dd.instrumentation_telemetry_data.tracers',
        metric: 'name',
        tags: [
          'foo:bar',
          'baz:buz',
          'lib_language:nodejs',
          `version:${process.version}`
        ],
        common: true,
        points: []
      })
    })

    it('should increment', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.count('name')

      metric.track = sinon.spy(metric.track)

      metric.inc()

      expect(metric.track).to.be.called

      expect(metric.points).to.deep.equal([
        [now / 1e3, 1]
      ])

      metric.inc()

      expect(metric.points).to.deep.equal([
        [now / 1e3, 2]
      ])
    })

    it('should decrement', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.count('name')

      metric.inc()
      metric.inc()

      metric.track = sinon.spy(metric.track)

      metric.dec()

      expect(metric.track).to.be.calledWith(-1)

      expect(metric.points).to.deep.equal([
        [now / 1e3, 1]
      ])
    })

    it('should retain timestamp of first change', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.count('name')

      metric.inc()

      Date.now.restore()
      const newNow = Date.now()
      sinon.stub(Date, 'now').returns(newNow)

      metric.inc()

      expect(metric.points).to.deep.equal([
        [now / 1e3, 2]
      ])
    })

    it('should reset state', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.count('name')

      metric.inc()
      metric.reset()

      expect(metric.points).to.deep.equal([])
    })

    it('should convert to json', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.count('name', {
        foo: 'bar',
        baz: 'buz'
      })

      metric.inc()

      expect(metric.toJSON()).to.deep.equal({
        metric: 'name',
        points: [[now / 1e3, 1]],
        interval: undefined,
        type: 'count',
        tags: [
          'foo:bar',
          'baz:buz',
          'lib_language:nodejs',
          `version:${process.version}`
        ],
        common: true
      })
    })
  })

  describe('GaugeMetric', () => {
    it('should expose input data', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.gauge('name', {
        foo: 'bar',
        baz: 'buz'
      })

      expect(metric.type).to.equal('gauge')
      expect(metric).to.deep.equal({
        namespace: 'dd.instrumentation_telemetry_data.tracers',
        metric: 'name',
        tags: [
          'foo:bar',
          'baz:buz',
          'lib_language:nodejs',
          `version:${process.version}`
        ],
        common: true,
        points: []
      })
    })

    it('should mark', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.gauge('name')

      metric.track = sinon.spy(metric.track)

      metric.mark(1)

      expect(metric.track).to.be.called

      expect(metric.points).to.deep.equal([
        [now / 1e3, 1]
      ])

      Date.now.restore()
      const newNow = Date.now()
      sinon.stub(Date, 'now').returns(newNow)

      metric.mark(2)

      expect(metric.points).to.deep.equal([
        [now / 1e3, 1],
        [newNow / 1e3, 2]
      ])
    })

    it('should reset state', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.gauge('name')

      metric.mark(1)
      metric.reset()

      expect(metric.points).to.deep.equal([])
    })

    it('should convert to json', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.gauge('name', {
        foo: 'bar',
        baz: 'buz'
      })

      metric.mark(1)

      Date.now.restore()
      const newNow = Date.now()
      sinon.stub(Date, 'now').returns(newNow)

      metric.mark(2)

      expect(metric.toJSON()).to.deep.equal({
        metric: 'name',
        points: [
          [now / 1e3, 1],
          [newNow / 1e3, 2]
        ],
        interval: undefined,
        type: 'gauge',
        tags: [
          'foo:bar',
          'baz:buz',
          'lib_language:nodejs',
          `version:${process.version}`
        ],
        common: true
      })
    })
  })

  describe('RateMetric', () => {
    it('should expose input data', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.rate('name', 1000, {
        foo: 'bar',
        baz: 'buz'
      })

      expect(metric.type).to.equal('rate')
      expect(metric).to.deep.equal({
        namespace: 'dd.instrumentation_telemetry_data.tracers',
        metric: 'name',
        tags: [
          'foo:bar',
          'baz:buz',
          'lib_language:nodejs',
          `version:${process.version}`
        ],
        common: true,
        points: [],
        interval: 1000,
        rate: 0
      })
    })

    it('should track', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.rate('name', 1000)

      metric.track(100)

      expect(metric.points).to.deep.equal([
        [now / 1e3, 0.1]
      ])
    })

    it('should reset state', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.rate('name', 1000)

      metric.track(1)
      metric.reset()

      expect(metric.points).to.deep.equal([])
    })

    it('should convert to json', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.rate('name', 1000, {
        foo: 'bar',
        baz: 'buz'
      })

      metric.track(123)

      expect(metric.toJSON()).to.deep.equal({
        metric: 'name',
        points: [
          [now / 1e3, 0.123]
        ],
        interval: 1000,
        type: 'rate',
        tags: [
          'foo:bar',
          'baz:buz',
          'lib_language:nodejs',
          `version:${process.version}`
        ],
        common: true
      })
    })
  })
})
