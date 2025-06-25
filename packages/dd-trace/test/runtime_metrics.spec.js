'use strict'

const t = require('tap')
require('./setup/core')
const { DogStatsDClient } = require('../src/dogstatsd')

const os = require('os')

const isWindows = os.platform() === 'win32'

const suiteDescribe = isWindows ? describe.skip : describe

suiteDescribe('runtimeMetrics (proxy)', () => {
  let runtimeMetrics
  let proxy

  t.beforeEach(() => {
    runtimeMetrics = sinon.spy({
      start () {},
      stop () {},
      track () {},
      boolean () {},
      histogram () {},
      count () {},
      gauge () {},
      increment () {},
      decrement () {}
    })

    proxy = proxyquire('../src/runtime_metrics', {
      './runtime_metrics': runtimeMetrics
    })
  })

  t.test('should be noop when disabled', t => {
    proxy.start()
    proxy.track()
    proxy.boolean()
    proxy.histogram()
    proxy.count()
    proxy.gauge()
    proxy.increment()
    proxy.decrement()
    proxy.stop()

    expect(runtimeMetrics.start).to.not.have.been.called
    expect(runtimeMetrics.track).to.not.have.been.called
    expect(runtimeMetrics.boolean).to.not.have.been.called
    expect(runtimeMetrics.histogram).to.not.have.been.called
    expect(runtimeMetrics.count).to.not.have.been.called
    expect(runtimeMetrics.gauge).to.not.have.been.called
    expect(runtimeMetrics.increment).to.not.have.been.called
    expect(runtimeMetrics.decrement).to.not.have.been.called
    expect(runtimeMetrics.stop).to.not.have.been.called
    t.end()
  })

  t.test('should proxy when enabled', t => {
    const config = { runtimeMetrics: true }

    proxy.start(config)
    proxy.track()
    proxy.boolean()
    proxy.histogram()
    proxy.count()
    proxy.gauge()
    proxy.increment()
    proxy.decrement()
    proxy.stop()

    expect(runtimeMetrics.start).to.have.been.calledWith(config)
    expect(runtimeMetrics.track).to.have.been.called
    expect(runtimeMetrics.boolean).to.have.been.called
    expect(runtimeMetrics.histogram).to.have.been.called
    expect(runtimeMetrics.count).to.have.been.called
    expect(runtimeMetrics.gauge).to.have.been.called
    expect(runtimeMetrics.increment).to.have.been.called
    expect(runtimeMetrics.decrement).to.have.been.called
    expect(runtimeMetrics.stop).to.have.been.called
    t.end()
  })

  t.test('should be noop when disabled after being enabled', t => {
    const config = { runtimeMetrics: true }

    proxy.start(config)
    proxy.stop()
    proxy.start()
    proxy.track()
    proxy.boolean()
    proxy.histogram()
    proxy.count()
    proxy.gauge()
    proxy.increment()
    proxy.decrement()
    proxy.stop()

    expect(runtimeMetrics.start).to.have.been.calledOnce
    expect(runtimeMetrics.track).to.not.have.been.called
    expect(runtimeMetrics.boolean).to.not.have.been.called
    expect(runtimeMetrics.histogram).to.not.have.been.called
    expect(runtimeMetrics.count).to.not.have.been.called
    expect(runtimeMetrics.gauge).to.not.have.been.called
    expect(runtimeMetrics.increment).to.not.have.been.called
    expect(runtimeMetrics.decrement).to.not.have.been.called
    expect(runtimeMetrics.stop).to.have.been.calledOnce
    t.end()
  })
})

suiteDescribe('runtimeMetrics', () => {
  let runtimeMetrics
  let config
  let clock
  let setImmediate
  let client
  let Client

  t.beforeEach(() => {
    // This is needed because sinon spies keep references to arguments which
    // breaks tests because the tags parameter is now mutated right after the
    // call.
    const wrapSpy = (client, spy) => {
      return function (stat, value, tags) {
        return spy.call(client, stat, value, [].concat(tags))
      }
    }

    Client = sinon.spy(function () {
      return {
        gauge: wrapSpy(client, client.gauge),
        increment: wrapSpy(client, client.increment),
        histogram: wrapSpy(client, client.histogram),
        flush: client.flush.bind(client)
      }
    })

    Client.generateClientConfig = DogStatsDClient.generateClientConfig

    client = {
      gauge: sinon.spy(),
      increment: sinon.spy(),
      histogram: sinon.spy(),
      flush: sinon.spy()
    }

    runtimeMetrics = proxyquire('../src/runtime_metrics/runtime_metrics', {
      '../dogstatsd': {
        DogStatsDClient: Client
      }
    })

    config = {
      hostname: 'localhost',
      port: '8126',
      dogstatsd: {
        hostname: 'localhost',
        port: 8125
      },
      tags: {
        str: 'bar',
        obj: {},
        invalid: 't{e*s#t5-:./'
      }
    }

    setImmediate = require('timers/promises').setImmediate
    clock = sinon.useFakeTimers()

    runtimeMetrics.start(config)
  })

  t.afterEach(() => {
    clock.restore()
    runtimeMetrics.stop()
  })

  t.test('start', t => {
    t.test('it should initialize the Dogstatsd client with the correct options', function (t) {
      runtimeMetrics.stop()
      runtimeMetrics.start(config)

      expect(Client).to.have.been.calledWithMatch({
        metricsProxyUrl: new URL('http://localhost:8126'),
        host: 'localhost',
        tags: [
          'str:bar',
          'invalid:t_e_s_t5-:./'
        ]
      })
      t.end()
    })

    t.test('it should initialize the Dogstatsd client with an IPv6 URL', function (t) {
      config.hostname = '::1'

      runtimeMetrics.stop()
      runtimeMetrics.start(config)

      expect(Client).to.have.been.calledWithMatch({
        metricsProxyUrl: new URL('http://[::1]:8126'),
        host: 'localhost',
        tags: [
          'str:bar',
          'invalid:t_e_s_t5-:./'
        ]
      })
      t.end()
    })

    t.test('should start collecting runtimeMetrics every 10 seconds', async t => {
      runtimeMetrics.stop()
      runtimeMetrics.start(config)

      global.gc()

      // Wait for GC observer to trigger.
      await setImmediate()
      await setImmediate()

      clock.tick(10000)

      expect(client.gauge).to.have.been.calledWith('runtime.node.cpu.user')
      expect(client.gauge).to.have.been.calledWith('runtime.node.cpu.system')
      expect(client.gauge).to.have.been.calledWith('runtime.node.cpu.total')

      expect(client.gauge).to.have.been.calledWith('runtime.node.mem.rss')
      expect(client.gauge).to.have.been.calledWith('runtime.node.mem.heap_total')
      expect(client.gauge).to.have.been.calledWith('runtime.node.mem.heap_used')

      expect(client.gauge).to.have.been.calledWith('runtime.node.process.uptime')

      expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_heap_size')
      expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_heap_size_executable')
      expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_physical_size')
      expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_available_size')
      expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_heap_size')
      expect(client.gauge).to.have.been.calledWith('runtime.node.heap.heap_size_limit')

      expect(client.gauge).to.have.been.calledWith('runtime.node.heap.malloced_memory')
      expect(client.gauge).to.have.been.calledWith('runtime.node.heap.peak_malloced_memory')

      expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.max', sinon.match.number)
      expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.min', sinon.match.number)
      expect(client.increment).to.have.been.calledWith('runtime.node.event_loop.delay.sum', sinon.match.number)
      expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.avg', sinon.match.number)
      expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.median', sinon.match.number)
      expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.95percentile', sinon.match.number)
      expect(client.increment).to.have.been.calledWith('runtime.node.event_loop.delay.count', sinon.match.number)

      expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.utilization')

      expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.max', sinon.match.number)
      expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.min', sinon.match.number)
      expect(client.increment).to.have.been.calledWith('runtime.node.gc.pause.sum', sinon.match.number)
      expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.avg', sinon.match.number)
      expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.median', sinon.match.number)
      expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.95percentile', sinon.match.number)
      expect(client.increment).to.have.been.calledWith('runtime.node.gc.pause.count', sinon.match.number)

      expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.by.type.max', sinon.match.number)
      expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.by.type.min', sinon.match.number)
      expect(client.increment).to.have.been.calledWith('runtime.node.gc.pause.by.type.sum', sinon.match.number)
      expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.by.type.avg', sinon.match.number)
      expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.by.type.median', sinon.match.number)
      expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.by.type.95percentile', sinon.match.number)
      expect(client.increment).to.have.been.calledWith('runtime.node.gc.pause.by.type.count', sinon.match.number)
      expect(client.increment).to.have.been.calledWith(
        'runtime.node.gc.pause.by.type.count', sinon.match.any, sinon.match(val => {
          return val && /^gc_type:[a-z_]+$/.test(val[0])
        })
      )

      expect(client.gauge).to.have.been.calledWith('runtime.node.heap.size.by.space')
      expect(client.gauge).to.have.been.calledWith('runtime.node.heap.used_size.by.space')
      expect(client.gauge).to.have.been.calledWith('runtime.node.heap.available_size.by.space')
      expect(client.gauge).to.have.been.calledWith('runtime.node.heap.physical_size.by.space')

      expect(client.flush).to.have.been.called
      t.end()
    })

    t.test('should collect individual metrics only once every 10 seconds', async t => {
      runtimeMetrics.stop()
      runtimeMetrics.start(config)

      global.gc()

      // Wait for GC observer to trigger.
      await setImmediate()
      await setImmediate()

      clock.tick(60 * 60 * 1000)

      // If a metric is leaking, it will leak expontentially because it will
      // be sent one more time each flush, in addition to the previous
      // flushes that also had the metric multiple times in them, so after
      // 1 hour even if a single metric is leaking it would get over
      // 64980 calls on its own without any other metric. A slightly lower
      // value is used here to be on the safer side.
      expect(client.gauge.callCount).to.be.lt(60000)
      expect(client.increment.callCount).to.be.lt(60000)
      t.end()
    })
    t.end()
  })

  t.test('when started', t => {
    t.test('stop', t => {
      t.test('should stop collecting runtimeMetrics every 10 seconds', t => {
        runtimeMetrics.stop()

        clock.tick(10000)

        expect(client.gauge).to.not.have.been.called
        t.end()
      })
      t.end()
    })

    t.test('histogram', t => {
      t.test('should add a record to a histogram', t => {
        runtimeMetrics.histogram('test', 0)
        runtimeMetrics.histogram('test', 1)
        runtimeMetrics.histogram('test', 2)
        runtimeMetrics.histogram('test', 3)

        clock.tick(10000)

        expect(client.gauge).to.have.been.calledWith('test.max', 3)
        expect(client.gauge).to.have.been.calledWith('test.min', 0)
        expect(client.increment).to.have.been.calledWith('test.sum', 6)
        expect(client.increment).to.have.been.calledWith('test.total', 6)
        expect(client.gauge).to.have.been.calledWith('test.avg', 1.5)
        expect(client.gauge).to.have.been.calledWith('test.median', sinon.match.number)
        expect(client.gauge).to.have.been.calledWith('test.95percentile', sinon.match.number)
        expect(client.increment).to.have.been.calledWith('test.count', 4)
        t.end()
      })
      t.end()
    })

    t.test('increment', t => {
      t.test('should increment a gauge', t => {
        runtimeMetrics.increment('test')

        clock.tick(10000)

        expect(client.gauge).to.have.been.calledWith('test', 1)
        t.end()
      })

      t.test('should increment a gauge with a tag', t => {
        runtimeMetrics.increment('test', 'foo:bar')

        clock.tick(10000)

        expect(client.gauge).to.have.been.calledWith('test', 1, ['foo:bar'])
        t.end()
      })

      t.test('should increment a monotonic counter', t => {
        runtimeMetrics.increment('test', true)

        clock.tick(10000)

        expect(client.increment).to.have.been.calledWith('test', 1)

        client.increment.resetHistory()

        clock.tick(10000)

        expect(client.increment).to.not.have.been.calledWith('test')
        t.end()
      })

      t.test('should increment a monotonic counter with a tag', t => {
        runtimeMetrics.increment('test', 'foo:bar', true)

        clock.tick(10000)

        expect(client.increment).to.have.been.calledWith('test', 1, ['foo:bar'])

        client.increment.resetHistory()

        clock.tick(10000)

        expect(client.increment).to.not.have.been.calledWith('test')
        t.end()
      })
      t.end()
    })

    t.test('decrement', t => {
      t.test('should increment a gauge', t => {
        runtimeMetrics.decrement('test')

        clock.tick(10000)

        expect(client.gauge).to.have.been.calledWith('test', -1)
        t.end()
      })

      t.test('should decrement a gauge with a tag', t => {
        runtimeMetrics.decrement('test', 'foo:bar')

        clock.tick(10000)

        expect(client.gauge).to.have.been.calledWith('test', -1, ['foo:bar'])
        t.end()
      })
      t.end()
    })

    t.test('gauge', t => {
      t.test('should set a gauge', t => {
        runtimeMetrics.gauge('test', 10)

        clock.tick(10000)

        expect(client.gauge).to.have.been.calledWith('test', 10)
        t.end()
      })

      t.test('should set a gauge with a tag', t => {
        runtimeMetrics.gauge('test', 10, 'foo:bar')

        clock.tick(10000)

        expect(client.gauge).to.have.been.calledWith('test', 10, ['foo:bar'])
        t.end()
      })
      t.end()
    })

    t.test('boolean', t => {
      t.test('should set a gauge', t => {
        runtimeMetrics.boolean('test', true)

        clock.tick(10000)

        expect(client.gauge).to.have.been.calledWith('test', 1)
        t.end()
      })

      t.test('should set a gauge with a tag', t => {
        runtimeMetrics.boolean('test', true, 'foo:bar')

        clock.tick(10000)

        expect(client.gauge).to.have.been.calledWith('test', 1, ['foo:bar'])
        t.end()
      })
      t.end()
    })

    t.test('without native runtimeMetrics', t => {
      t.beforeEach(() => {
        runtimeMetrics = proxyquire('../src/runtime_metrics/runtime_metrics', {
          '../dogstatsd': Client,
          'node-gyp-build': sinon.stub().returns(null)
        })
      })

      t.test('should fallback to only runtimeMetrics available to JavaScript code', t => {
        clock.tick(10000)

        expect(client.gauge).to.have.been.calledWith('runtime.node.cpu.user')
        expect(client.gauge).to.have.been.calledWith('runtime.node.cpu.system')
        expect(client.gauge).to.have.been.calledWith('runtime.node.cpu.total')

        expect(client.gauge).to.have.been.calledWith('runtime.node.mem.rss')
        expect(client.gauge).to.have.been.calledWith('runtime.node.mem.heap_total')
        expect(client.gauge).to.have.been.calledWith('runtime.node.mem.heap_used')

        expect(client.gauge).to.have.been.calledWith('runtime.node.process.uptime')

        expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_heap_size')
        expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_heap_size_executable')
        expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_physical_size')
        expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_available_size')
        expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_heap_size')
        expect(client.gauge).to.have.been.calledWith('runtime.node.heap.heap_size_limit')

        expect(client.gauge).to.have.been.calledWith('runtime.node.heap.malloced_memory')
        expect(client.gauge).to.have.been.calledWith('runtime.node.heap.peak_malloced_memory')

        expect(client.gauge).to.have.been.calledWith('runtime.node.heap.size.by.space')
        expect(client.gauge).to.have.been.calledWith('runtime.node.heap.used_size.by.space')
        expect(client.gauge).to.have.been.calledWith('runtime.node.heap.available_size.by.space')
        expect(client.gauge).to.have.been.calledWith('runtime.node.heap.physical_size.by.space')

        expect(client.flush).to.have.been.called
        t.end()
      })
      t.end()
    })
    t.end()
  })
})
