'use strict'

require('./setup/tap')

const os = require('os')

const isWindows = os.platform() === 'win32'

const suiteDescribe = isWindows ? describe.skip : describe

suiteDescribe('runtimeMetrics', () => {
  let runtimeMetrics
  let config
  let clock
  let client
  let Client

  beforeEach(() => {
    Client = sinon.spy(function () {
      return client
    })

    client = {
      gauge: sinon.spy(),
      increment: sinon.spy(),
      histogram: sinon.spy(),
      flush: sinon.spy()
    }

    runtimeMetrics = proxyquire('../src/runtime_metrics', {
      './dogstatsd': {
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

    clock = sinon.useFakeTimers()

    runtimeMetrics.start(config)
  })

  afterEach(() => {
    clock.restore()
    runtimeMetrics.stop()
  })

  describe('start', () => {
    it('it should initialize the Dogstatsd client with the correct options', function () {
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
    })

    it('it should initialize the Dogstatsd client with an IPv6 URL', function () {
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
    })

    it('should start collecting runtimeMetrics every 10 seconds', () => {
      runtimeMetrics.stop()
      runtimeMetrics.start(config)

      global.gc()

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

      expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.max')
      expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.min')
      expect(client.increment).to.have.been.calledWith('runtime.node.event_loop.delay.sum')
      expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.avg')
      expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.median')
      expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.95percentile')
      expect(client.increment).to.have.been.calledWith('runtime.node.event_loop.delay.count')

      expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.utilization')

      expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.max')
      expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.min')
      expect(client.increment).to.have.been.calledWith('runtime.node.gc.pause.sum')
      expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.avg')
      expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.median')
      expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.95percentile')
      expect(client.increment).to.have.been.calledWith('runtime.node.gc.pause.count')

      expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.by.type.max')
      expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.by.type.min')
      expect(client.increment).to.have.been.calledWith('runtime.node.gc.pause.by.type.sum')
      expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.by.type.avg')
      expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.by.type.median')
      expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.by.type.95percentile')
      expect(client.increment).to.have.been.calledWith('runtime.node.gc.pause.by.type.count')
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
    })
  })

  describe('when started', () => {
    describe('stop', () => {
      it('should stop collecting runtimeMetrics every 10 seconds', () => {
        runtimeMetrics.stop()

        clock.tick(10000)

        expect(client.gauge).to.not.have.been.called
      })
    })

    describe('histogram', () => {
      it('should add a record to a histogram', () => {
        runtimeMetrics.histogram('test', 1)
        runtimeMetrics.histogram('test', 2)
        runtimeMetrics.histogram('test', 3)

        clock.tick(10000)

        expect(client.gauge).to.have.been.calledWith('test.max', 3)
        expect(client.gauge).to.have.been.calledWith('test.min', 1)
        expect(client.increment).to.have.been.calledWith('test.sum', 6)
        expect(client.increment).to.have.been.calledWith('test.total', 6)
        expect(client.gauge).to.have.been.calledWith('test.avg', 2)
        expect(client.gauge).to.have.been.calledWith('test.median', sinon.match.number)
        expect(client.gauge).to.have.been.calledWith('test.95percentile', sinon.match.number)
        expect(client.increment).to.have.been.calledWith('test.count', 3)
      })
    })

    describe('increment', () => {
      it('should increment a gauge', () => {
        runtimeMetrics.increment('test')

        clock.tick(10000)

        expect(client.gauge).to.have.been.calledWith('test', 1)
      })

      it('should increment a gauge with a tag', () => {
        runtimeMetrics.increment('test', 'foo:bar')

        clock.tick(10000)

        expect(client.gauge).to.have.been.calledWith('test', 1, ['foo:bar'])
      })

      it('should increment a monotonic counter', () => {
        runtimeMetrics.increment('test', true)

        clock.tick(10000)

        expect(client.increment).to.have.been.calledWith('test', 1)

        client.increment.resetHistory()

        clock.tick(10000)

        expect(client.increment).to.not.have.been.calledWith('test')
      })

      it('should increment a monotonic counter with a tag', () => {
        runtimeMetrics.increment('test', 'foo:bar', true)

        clock.tick(10000)

        expect(client.increment).to.have.been.calledWith('test', 1, ['foo:bar'])

        client.increment.resetHistory()

        clock.tick(10000)

        expect(client.increment).to.not.have.been.calledWith('test')
      })
    })

    describe('decrement', () => {
      it('should increment a gauge', () => {
        runtimeMetrics.decrement('test')

        clock.tick(10000)

        expect(client.gauge).to.have.been.calledWith('test', -1)
      })

      it('should decrement a gauge with a tag', () => {
        runtimeMetrics.decrement('test', 'foo:bar')

        clock.tick(10000)

        expect(client.gauge).to.have.been.calledWith('test', -1, ['foo:bar'])
      })
    })

    describe('gauge', () => {
      it('should set a gauge', () => {
        runtimeMetrics.gauge('test', 10)

        clock.tick(10000)

        expect(client.gauge).to.have.been.calledWith('test', 10)
      })

      it('should set a gauge with a tag', () => {
        runtimeMetrics.gauge('test', 10, 'foo:bar')

        clock.tick(10000)

        expect(client.gauge).to.have.been.calledWith('test', 10, ['foo:bar'])
      })
    })

    describe('boolean', () => {
      it('should set a gauge', () => {
        runtimeMetrics.boolean('test', true)

        clock.tick(10000)

        expect(client.gauge).to.have.been.calledWith('test', 1)
      })

      it('should set a gauge with a tag', () => {
        runtimeMetrics.boolean('test', true, 'foo:bar')

        clock.tick(10000)

        expect(client.gauge).to.have.been.calledWith('test', 1, ['foo:bar'])
      })
    })

    describe('without native runtimeMetrics', () => {
      beforeEach(() => {
        runtimeMetrics = proxyquire('../src/runtime_metrics', {
          './dogstatsd': Client,
          'node-gyp-build': sinon.stub().returns(null)
        })
      })

      it('should fallback to only runtimeMetrics available to JavaScript code', () => {
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
      })
    })
  })
})
