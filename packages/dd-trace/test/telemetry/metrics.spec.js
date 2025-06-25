'use strict'

const t = require('tap')
require('../setup/core')

const proxyquire = require('proxyquire')

t.test('metrics', t => {
  let metrics
  let sendData
  let now

  t.beforeEach(() => {
    now = Date.now()
    sinon.stub(Date, 'now').returns(now)

    sendData = sinon.stub()
    metrics = proxyquire('../../src/telemetry/metrics', {
      './send-data': {
        sendData
      }
    })
  })

  t.afterEach(() => {
    Date.now.restore()
  })

  t.test('NamespaceManager', t => {
    t.test('should export singleton manager', t => {
      expect(metrics.manager).to.be.instanceOf(metrics.NamespaceManager)
      t.end()
    })

    t.test('should make namespaces', t => {
      const manager = new metrics.NamespaceManager()
      const ns = manager.namespace('test')
      expect(ns).to.be.instanceOf(metrics.Namespace)
      expect(ns.metrics.namespace).to.equal('test')
      t.end()
    })

    t.test('should reuse namespace instances with the same name', t => {
      const manager = new metrics.NamespaceManager()
      const ns = manager.namespace('test')
      expect(manager.namespace('test')).to.equal(ns)
      t.end()
    })

    t.test('should convert to json', t => {
      const manager = new metrics.NamespaceManager()

      const test1 = manager.namespace('test1')
      const test2 = manager.namespace('test2')

      test1.count('metric1', { bar: 'baz' }).inc()
      test2.count('metric2', { bux: 'bax' }).inc()

      expect(manager.toJSON()).to.deep.equal([
        {
          distributions: undefined,
          metrics: {
            namespace: 'test1',
            series: [
              {
                metric: 'metric1',
                points: [[now / 1e3, 1]],
                interval: undefined,
                type: 'count',
                tags: [
                  'bar:baz'
                ],
                common: true
              }
            ]
          }
        },
        {
          distributions: undefined,
          metrics: {
            namespace: 'test2',
            series: [
              {
                metric: 'metric2',
                points: [[now / 1e3, 1]],
                interval: undefined,
                type: 'count',
                tags: [
                  'bux:bax'
                ],
                common: true
              }
            ]
          }
        }
      ])
      t.end()
    })

    t.test('should send data', t => {
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
                'bar:baz'
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
                'bux:bax'
              ],
              common: true
            }
          ]
        })
      t.end()
    })

    t.test('should not send empty metrics', t => {
      const manager = new metrics.NamespaceManager()

      const ns = manager.namespace('test')

      const metric = ns.count('metric', { bar: 'baz' })
      metric.inc()
      metric.reset()

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

      expect(sendData).to.not.have.been.called
      t.end()
    })
    t.end()
  })

  t.test('Namespace', t => {
    t.test('should pass namespace name through to collections', t => {
      const ns = new metrics.Namespace('name')
      expect(ns.metrics).to.have.property('namespace', 'name')
      expect(ns.distributions).to.have.property('namespace', 'name')
      t.end()
    })

    t.test('should get count metric', t => {
      const ns = new metrics.Namespace('name')
      expect(ns.count('name')).to.be.instanceOf(metrics.CountMetric)
      t.end()
    })

    t.test('should get distribution metric', t => {
      const ns = new metrics.Namespace('name')
      expect(ns.distribution('name')).to.be.instanceOf(metrics.DistributionMetric)
      t.end()
    })

    t.test('should get gauge metric', t => {
      const ns = new metrics.Namespace('name')
      expect(ns.gauge('name')).to.be.instanceOf(metrics.GaugeMetric)
      t.end()
    })

    t.test('should get rate metric', t => {
      const ns = new metrics.Namespace('name')
      expect(ns.rate('name')).to.be.instanceOf(metrics.RateMetric)
      t.end()
    })

    t.test('should have unique metrics per unique tag set', t => {
      const ns = new metrics.Namespace('test')
      ns.count('foo', { bar: 'baz' }).inc()
      ns.count('foo', { bar: 'baz' }).inc() // not unique
      ns.count('foo', { bux: 'bax' }).inc()
      expect(ns.metrics).to.have.lengthOf(2)
      expect(ns.distributions).to.have.lengthOf(0)
      ns.distribution('foo', { bux: 'bax' }).track()
      expect(ns.distributions).to.have.lengthOf(1)
      t.end()
    })

    t.test('should reset metrics', t => {
      const ns = new metrics.Namespace('test')
      const metric = ns.count('foo', { bar: 'baz' })
      metric.inc()

      metric.reset = sinon.spy(metric.reset)

      expect(metric.points).to.have.lengthOf(1)
      ns.reset()
      expect(metric.points).to.have.lengthOf(0)

      expect(metric.reset).to.have.been.called
      t.end()
    })

    t.test('should convert to json', t => {
      const ns = new metrics.Namespace('test')
      ns.count('foo', { bar: 'baz' }).inc()
      ns.count('foo', { bux: 'bax' }).inc()

      expect(ns.toJSON()).to.deep.equal({
        distributions: undefined,
        metrics: {
          namespace: 'test',
          series: [
            {
              metric: 'foo',
              points: [[now / 1e3, 1]],
              interval: undefined,
              type: 'count',
              tags: [
                'bar:baz'
              ],
              common: true
            },
            {
              metric: 'foo',
              points: [[now / 1e3, 1]],
              interval: undefined,
              type: 'count',
              tags: [
                'bux:bax'
              ],
              common: true
            }
          ]
        }
      })
      t.end()
    })

    t.test('should skip empty metrics', t => {
      const ns = new metrics.Namespace('test')
      const metric = ns.count('foo', { bar: 'baz' })
      metric.inc()
      metric.reset()

      expect(ns.toJSON()).to.deep.equal({
        distributions: undefined,
        metrics: undefined
      })
      t.end()
    })
    t.end()
  })

  t.test('CountMetric', t => {
    t.test('should expose input data', t => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.count('name', {
        foo: 'bar',
        baz: 'buz'
      })

      expect(metric.type).to.equal('count')
      expect(metric).to.deep.equal({
        namespace: 'tracers',
        metric: 'name',
        tags: [
          'foo:bar',
          'baz:buz'
        ],
        common: true,
        points: []
      })
      t.end()
    })

    t.test('should increment', t => {
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
      t.end()
    })

    t.test('should decrement', t => {
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
      t.end()
    })

    t.test('should decrement with explicit arg', t => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.count('name')

      metric.inc(3)

      metric.track = sinon.spy(metric.track)

      metric.dec(2)

      expect(metric.track).to.be.calledWith(-2)

      expect(metric.points).to.deep.equal([
        [now / 1e3, 1]
      ])
      t.end()
    })

    t.test('should retain timestamp of first change', t => {
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
      t.end()
    })

    t.test('should reset state', t => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.count('name')

      metric.inc()
      metric.reset()

      expect(metric.points).to.deep.equal([])
      t.end()
    })

    t.test('should convert to json', t => {
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
          'baz:buz'
        ],
        common: true
      })
      t.end()
    })
    t.end()
  })

  t.test('DistributionMetric', t => {
    t.test('should expose input data', t => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.distribution('name', {
        foo: 'bar',
        baz: 'buz'
      })

      expect(metric.type).to.equal('distribution')
      expect(metric).to.deep.eql({
        namespace: 'tracers',
        metric: 'name',
        tags: [
          'foo:bar',
          'baz:buz'
        ],
        common: true,
        points: []
      })
      t.end()
    })

    t.test('should track', t => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.distribution('name')

      metric.track(100)
      metric.track(50)
      metric.track(300)

      expect(metric.points).to.deep.equal([
        100,
        50,
        300
      ])
      t.end()
    })

    t.test('should reset state', t => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.distribution('name')

      metric.track(1)
      metric.reset()

      expect(metric.points).to.deep.equal([])
      t.end()
    })

    t.test('should convert to json', t => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.distribution('name', {
        foo: 'bar',
        baz: 'buz'
      })

      metric.track(123)

      expect(metric.toJSON()).to.deep.equal({
        metric: 'name',
        points: [
          123
        ],
        common: true,
        tags: [
          'foo:bar',
          'baz:buz'
        ]
      })
      t.end()
    })
    t.end()
  })

  t.test('GaugeMetric', t => {
    t.test('should expose input data', t => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.gauge('name', {
        foo: 'bar',
        baz: 'buz'
      })

      expect(metric.type).to.equal('gauge')
      expect(metric).to.deep.equal({
        namespace: 'tracers',
        metric: 'name',
        tags: [
          'foo:bar',
          'baz:buz'
        ],
        common: true,
        points: []
      })
      t.end()
    })

    t.test('should mark', t => {
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
      t.end()
    })

    t.test('should reset state', t => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.gauge('name')

      metric.mark(1)
      metric.reset()

      expect(metric.points).to.deep.equal([])
      t.end()
    })

    t.test('should convert to json', t => {
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
          'baz:buz'
        ],
        common: true
      })
      t.end()
    })
    t.end()
  })

  t.test('RateMetric', t => {
    t.test('should expose input data', t => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.rate('name', 1000, {
        foo: 'bar',
        baz: 'buz'
      })

      expect(metric.type).to.equal('rate')
      expect(metric).to.deep.equal({
        namespace: 'tracers',
        metric: 'name',
        tags: [
          'foo:bar',
          'baz:buz'
        ],
        common: true,
        points: [],
        interval: 1000,
        rate: 0
      })
      t.end()
    })

    t.test('should track', t => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.rate('name', 1000)

      metric.track(100)

      expect(metric.points).to.deep.equal([
        [now / 1e3, 0.1]
      ])
      t.end()
    })

    t.test('should reset state', t => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.rate('name', 1000)

      metric.track(1)
      metric.reset()

      expect(metric.points).to.deep.equal([])
      t.end()
    })

    t.test('should convert to json', t => {
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
          'baz:buz'
        ],
        common: true
      })
      t.end()
    })
    t.end()
  })
  t.end()
})
