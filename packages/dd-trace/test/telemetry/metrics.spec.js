'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

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
        sendData,
      },
    })
  })

  afterEach(() => {
    Date.now.restore()
  })

  describe('NamespaceManager', () => {
    it('should export singleton manager', () => {
      assert.ok(metrics.manager instanceof metrics.NamespaceManager)
    })

    it('should make namespaces', () => {
      const manager = new metrics.NamespaceManager()
      const ns = manager.namespace('test')
      assert.ok(ns instanceof metrics.Namespace)
      assert.strictEqual(ns.metrics.namespace, 'test')
    })

    it('should reuse namespace instances with the same name', () => {
      const manager = new metrics.NamespaceManager()
      const ns = manager.namespace('test')
      assert.strictEqual(manager.namespace('test'), ns)
    })

    it('should convert to json', () => {
      const manager = new metrics.NamespaceManager()

      const test1 = manager.namespace('test1')
      const test2 = manager.namespace('test2')

      test1.count('metric1', { bar: 'baz' }).inc()
      test2.count('metric2', { bux: 'bax' }).inc()

      assert.deepStrictEqual(manager.toJSON(), [
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
                  'bar:baz',
                ],
                common: true,
              },
            ],
          },
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
                  'bux:bax',
                ],
                common: true,
              },
            ],
          },
        },
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
          'runtime-id': 'abc123',
        },
      }
      const application = {
        language_name: 'nodejs',
        tracer_version: '1.2.3',
      }
      const host = {}

      manager.send(config, application, host)

      sinon.assert.calledWith(sendData, config, application, host, 'generate-metrics', {
        namespace: 'test1',
        series: [
          {
            metric: 'metric1',
            points: [[now / 1e3, 1]],
            interval: undefined,
            type: 'count',
            tags: [
              'bar:baz',
            ],
            common: true,
          },
        ],
      })
      sinon.assert.calledWith(sendData, config, application, host, 'generate-metrics', {
        namespace: 'test2',
        series: [
          {
            metric: 'metric2',
            points: [[now / 1e3, 1]],
            interval: undefined,
            type: 'count',
            tags: [
              'bux:bax',
            ],
            common: true,
          },
        ],
      })
    })

    it('should not send empty metrics', () => {
      const manager = new metrics.NamespaceManager()

      const ns = manager.namespace('test')

      const metric = ns.count('metric', { bar: 'baz' })
      metric.inc()
      metric.reset()

      const config = {
        hostname: 'localhost',
        port: 12345,
        tags: {
          'runtime-id': 'abc123',
        },
      }
      const application = {
        language_name: 'nodejs',
        tracer_version: '1.2.3',
      }
      const host = {}

      manager.send(config, application, host)

      sinon.assert.notCalled(sendData)
    })
  })

  describe('Namespace', () => {
    it('should pass namespace name through to collections', () => {
      const ns = new metrics.Namespace('name')
      assert.strictEqual(ns.metrics.namespace, 'name')
      assert.strictEqual(ns.distributions.namespace, 'name')
    })

    it('should get count metric', () => {
      const ns = new metrics.Namespace('name')
      assert.ok(ns.count('name') instanceof metrics.CountMetric)
    })

    it('should get distribution metric', () => {
      const ns = new metrics.Namespace('name')
      assert.ok(ns.distribution('name') instanceof metrics.DistributionMetric)
    })

    it('should get gauge metric', () => {
      const ns = new metrics.Namespace('name')
      assert.ok(ns.gauge('name') instanceof metrics.GaugeMetric)
    })

    it('should get rate metric', () => {
      const ns = new metrics.Namespace('name')
      assert.ok(ns.rate('name') instanceof metrics.RateMetric)
    })

    it('should have unique metrics per unique tag set', () => {
      const ns = new metrics.Namespace('test')
      ns.count('foo', { bar: 'baz' }).inc()
      ns.count('foo', { bar: 'baz' }).inc() // not unique
      ns.count('foo', { bux: 'bax' }).inc()
      assert.strictEqual(ns.metrics.size, 2)
      assert.strictEqual(ns.distributions.size, 0)
      ns.distribution('foo', { bux: 'bax' }).track()
      assert.strictEqual(ns.distributions.size, 1)
    })

    it('should reset metrics', () => {
      const ns = new metrics.Namespace('test')
      const metric = ns.count('foo', { bar: 'baz' })
      metric.inc()

      metric.reset = sinon.spy(metric.reset)

      assert.strictEqual(metric.points.length, 1)
      ns.reset()
      assert.strictEqual(metric.points.length, 0)

      sinon.assert.called(metric.reset)
    })

    it('should convert to json', () => {
      const ns = new metrics.Namespace('test')
      ns.count('foo', { bar: 'baz' }).inc()
      ns.count('foo', { bux: 'bax' }).inc()

      assert.deepStrictEqual(ns.toJSON(), {
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
                'bar:baz',
              ],
              common: true,
            },
            {
              metric: 'foo',
              points: [[now / 1e3, 1]],
              interval: undefined,
              type: 'count',
              tags: [
                'bux:bax',
              ],
              common: true,
            },
          ],
        },
      })
    })

    it('should skip empty metrics', () => {
      const ns = new metrics.Namespace('test')
      const metric = ns.count('foo', { bar: 'baz' })
      metric.inc()
      metric.reset()

      assert.deepStrictEqual(ns.toJSON(), {
        distributions: undefined,
        metrics: undefined,
      })
    })
  })

  describe('CountMetric', () => {
    it('should expose input data', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.count('name', {
        foo: 'bar',
        baz: 'buz',
      })

      assert.strictEqual(metric.type, 'count')
      const expected = {
        namespace: 'tracers',
        metric: 'name',
        tags: [
          'foo:bar',
          'baz:buz',
        ],
        common: true,
        points: [],
      }
      Object.setPrototypeOf(expected, Object.getPrototypeOf(metric))
      assert.deepStrictEqual(metric, expected)
    })

    it('should increment', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.count('name')

      metric.track = sinon.spy(metric.track)

      metric.inc()

      sinon.assert.called(metric.track)

      assert.deepStrictEqual(metric.points, [
        [now / 1e3, 1],
      ])

      metric.inc()

      assert.deepStrictEqual(metric.points, [
        [now / 1e3, 2],
      ])
    })

    it('should decrement', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.count('name')

      metric.inc()
      metric.inc()

      metric.track = sinon.spy(metric.track)

      metric.dec()

      sinon.assert.calledWith(metric.track, -1)

      assert.deepStrictEqual(metric.points, [
        [now / 1e3, 1],
      ])
    })

    it('should decrement with explicit arg', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.count('name')

      metric.inc(3)

      metric.track = sinon.spy(metric.track)

      metric.dec(2)

      sinon.assert.calledWith(metric.track, -2)

      assert.deepStrictEqual(metric.points, [
        [now / 1e3, 1],
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

      assert.deepStrictEqual(metric.points, [
        [now / 1e3, 2],
      ])
    })

    it('should reset state', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.count('name')

      metric.inc()
      metric.reset()

      assert.deepStrictEqual(metric.points, [])
    })

    it('should convert to json', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.count('name', {
        foo: 'bar',
        baz: 'buz',
      })

      metric.inc()

      assert.deepStrictEqual(metric.toJSON(), {
        metric: 'name',
        points: [[now / 1e3, 1]],
        interval: undefined,
        type: 'count',
        tags: [
          'foo:bar',
          'baz:buz',
        ],
        common: true,
      })
    })
  })

  describe('DistributionMetric', () => {
    it('should expose input data', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.distribution('name', {
        foo: 'bar',
        baz: 'buz',
      })

      assert.strictEqual(metric.type, 'distribution')
      const expected = {
        namespace: 'tracers',
        metric: 'name',
        tags: [
          'foo:bar',
          'baz:buz',
        ],
        common: true,
        points: [],
      }
      Object.setPrototypeOf(expected, Object.getPrototypeOf(metric))
      assert.deepStrictEqual(metric, expected)
    })

    it('should track', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.distribution('name')

      metric.track(100)
      metric.track(50)
      metric.track(300)

      assert.deepStrictEqual(metric.points, [
        100,
        50,
        300,
      ])
    })

    it('should reset state', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.distribution('name')

      metric.track(1)
      metric.reset()

      assert.deepStrictEqual(metric.points, [])
    })

    it('should convert to json', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.distribution('name', {
        foo: 'bar',
        baz: 'buz',
      })

      metric.track(123)

      assert.deepStrictEqual(metric.toJSON(), {
        metric: 'name',
        points: [
          123,
        ],
        common: true,
        tags: [
          'foo:bar',
          'baz:buz',
        ],
      })
    })
  })

  describe('GaugeMetric', () => {
    it('should expose input data', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.gauge('name', {
        foo: 'bar',
        baz: 'buz',
      })

      assert.strictEqual(metric.type, 'gauge')
      const expected = {
        namespace: 'tracers',
        metric: 'name',
        tags: [
          'foo:bar',
          'baz:buz',
        ],
        common: true,
        points: [],
      }
      Object.setPrototypeOf(expected, Object.getPrototypeOf(metric))
      assert.deepStrictEqual(metric, expected)
    })

    it('should mark', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.gauge('name')

      metric.track = sinon.spy(metric.track)

      metric.mark(1)

      sinon.assert.called(metric.track)

      assert.deepStrictEqual(metric.points, [
        [now / 1e3, 1],
      ])

      Date.now.restore()
      const newNow = Date.now()
      sinon.stub(Date, 'now').returns(newNow)

      metric.mark(2)

      assert.deepStrictEqual(metric.points, [
        [now / 1e3, 1],
        [newNow / 1e3, 2],
      ])
    })

    it('should reset state', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.gauge('name')

      metric.mark(1)
      metric.reset()

      assert.deepStrictEqual(metric.points, [])
    })

    it('should convert to json', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.gauge('name', {
        foo: 'bar',
        baz: 'buz',
      })

      metric.mark(1)

      Date.now.restore()
      const newNow = Date.now()
      sinon.stub(Date, 'now').returns(newNow)

      metric.mark(2)

      assert.deepStrictEqual(metric.toJSON(), {
        metric: 'name',
        points: [
          [now / 1e3, 1],
          [newNow / 1e3, 2],
        ],
        interval: undefined,
        type: 'gauge',
        tags: [
          'foo:bar',
          'baz:buz',
        ],
        common: true,
      })
    })
  })

  describe('RateMetric', () => {
    it('should expose input data', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.rate('name', 1000, {
        foo: 'bar',
        baz: 'buz',
      })

      assert.strictEqual(metric.type, 'rate')
      const expected = {
        namespace: 'tracers',
        metric: 'name',
        tags: [
          'foo:bar',
          'baz:buz',
        ],
        common: true,
        points: [],
        interval: 1000,
        rate: 0,
      }
      Object.setPrototypeOf(expected, Object.getPrototypeOf(metric))
      assert.deepStrictEqual(metric, expected)
    })

    it('should track', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.rate('name', 1000)

      metric.track(100)

      assert.deepStrictEqual(metric.points, [
        [now / 1e3, 0.1],
      ])
    })

    it('should reset state', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.rate('name', 1000)

      metric.track(1)
      metric.reset()

      assert.deepStrictEqual(metric.points, [])
    })

    it('should convert to json', () => {
      const ns = new metrics.Namespace('tracers')
      const metric = ns.rate('name', 1000, {
        foo: 'bar',
        baz: 'buz',
      })

      metric.track(123)

      assert.deepStrictEqual(metric.toJSON(), {
        metric: 'name',
        points: [
          [now / 1e3, 0.123],
        ],
        interval: 1000,
        type: 'rate',
        tags: [
          'foo:bar',
          'baz:buz',
        ],
        common: true,
      })
    })
  })
})
