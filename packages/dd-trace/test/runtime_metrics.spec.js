'use strict'

const assert = require('node:assert')
const os = require('node:os')
const { performance } = require('node:perf_hooks')
const { setImmediate, setTimeout } = require('node:timers/promises')
const util = require('node:util')

const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')
const { metrics } = require('@opentelemetry/api')

require('./setup/core')
const { DogStatsDClient } = require('../src/dogstatsd')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const MeterProvider = require('../src/opentelemetry/metrics/meter_provider')
const PeriodicMetricReader = require('../src/opentelemetry/metrics/periodic_metric_reader')
const OtlpTransformer = require('../src/opentelemetry/metrics/otlp_transformer')
const otlpRuntimeMetrics = require('../src/runtime_metrics/otlp_runtime_metrics')

function createGarbage (count = 50) {
  let last = {}
  const obj = last

  for (let i = 0; i < count; i++) {
    last.next = { circular: obj, last, obj: { a: 1, b: 2, c: true } }
    // @ts-expect-error - Difficult to define type
    last = last.next
    // @ts-expect-error - Difficult to define type
    last.map = new Map([['a', 1], ['b', 2], ['c', true]])
    obj[i] = last
  }

  return util.inspect(obj, { depth: Infinity })
}

[true, false].forEach((nativeMetrics) => {
  describe(`runtimeMetrics ${nativeMetrics ? 'with' : 'without'} native metrics`, () => {
    describe('runtimeMetrics (proxy)', () => {
      let runtimeMetrics
      let proxy
      let config

      before(() => {
        require('../src/process-tags').initialize()
      })

      beforeEach(() => {
        config = {
          runtimeMetrics: {
            enabled: false,
          },
        }

        runtimeMetrics = sinon.spy({
          start () {},
          stop () {},
          track () {},
          boolean () {},
          histogram () {},
          count () {},
          gauge () {},
          increment () {},
          decrement () {},
        })

        proxy = proxyquire('../src/runtime_metrics', {
          './runtime_metrics': runtimeMetrics,
        })
      })

      it('should be noop when disabled', () => {
        proxy.start()
        proxy.track()
        proxy.boolean()
        proxy.histogram()
        proxy.count()
        proxy.gauge()
        proxy.increment()
        proxy.decrement()
        proxy.stop()

        sinon.assert.notCalled(runtimeMetrics.start)
        sinon.assert.notCalled(runtimeMetrics.track)
        sinon.assert.notCalled(runtimeMetrics.boolean)
        sinon.assert.notCalled(runtimeMetrics.histogram)
        sinon.assert.notCalled(runtimeMetrics.count)
        sinon.assert.notCalled(runtimeMetrics.gauge)
        sinon.assert.notCalled(runtimeMetrics.increment)
        sinon.assert.notCalled(runtimeMetrics.decrement)
        sinon.assert.notCalled(runtimeMetrics.stop)
      })

      it('should proxy when enabled', () => {
        config.runtimeMetrics.enabled = true

        proxy.start(config)
        proxy.track()
        proxy.boolean()
        proxy.histogram()
        proxy.count()
        proxy.gauge()
        proxy.increment()
        proxy.decrement()
        proxy.stop()

        sinon.assert.calledWith(runtimeMetrics.start, config)
        sinon.assert.called(runtimeMetrics.track)
        sinon.assert.called(runtimeMetrics.boolean)
        sinon.assert.called(runtimeMetrics.histogram)
        sinon.assert.called(runtimeMetrics.count)
        sinon.assert.called(runtimeMetrics.gauge)
        sinon.assert.called(runtimeMetrics.increment)
        sinon.assert.called(runtimeMetrics.decrement)
        sinon.assert.called(runtimeMetrics.stop)
      })

      it('should be noop when disabled after being enabled', () => {
        config.runtimeMetrics.enabled = true
        proxy.start(config)
        proxy.stop()
        config.runtimeMetrics.enabled = false
        proxy.start(config)
        proxy.track()
        proxy.boolean()
        proxy.histogram()
        proxy.count()
        proxy.gauge()
        proxy.increment()
        proxy.decrement()
        proxy.stop()

        sinon.assert.calledOnce(runtimeMetrics.start)
        sinon.assert.notCalled(runtimeMetrics.track)
        sinon.assert.notCalled(runtimeMetrics.boolean)
        sinon.assert.notCalled(runtimeMetrics.histogram)
        sinon.assert.notCalled(runtimeMetrics.count)
        sinon.assert.notCalled(runtimeMetrics.gauge)
        sinon.assert.notCalled(runtimeMetrics.increment)
        sinon.assert.notCalled(runtimeMetrics.decrement)
        sinon.assert.calledOnce(runtimeMetrics.stop)
      })
    })

    describe('runtimeMetrics', () => {
      let runtimeMetrics
      let config
      let clock
      let client
      let Client

      beforeEach(() => {
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
            flush: client.flush.bind(client),
          }
        })

        Client.generateClientConfig = DogStatsDClient.generateClientConfig

        client = {
          gauge: sinon.spy(),
          increment: sinon.spy(),
          histogram: sinon.spy(),
          flush: sinon.spy(),
        }

        const proxiedObject = {
          '../dogstatsd': {
            DogStatsDClient: Client,
          },
        }
        if (!nativeMetrics) {
          proxiedObject['@datadog/native-metrics'] = {
            start () {
              throw new Error('Native metrics are not supported in this environment')
            },
          }
        } else {
          // The log is called in case native metrics fail to load.
          proxiedObject['../log'] = {
            error () {
              throw new Error('Native metrics should load properly')
            },
          }
        }

        runtimeMetrics = proxyquire('../src/runtime_metrics/runtime_metrics', proxiedObject)

        config = {
          hostname: 'localhost',
          port: '8126',
          dogstatsd: {
            hostname: 'localhost',
            port: 8125,
          },
          runtimeMetrics: {
            enabled: true,
            eventLoop: true,
            gc: true,
          },
          tags: {
            str: 'bar',
            obj: {},
            invalid: 't{e*s#t5-:./',
          },
          DD_RUNTIME_METRICS_FLUSH_INTERVAL: 10000,
          getOrigin: () => {
            return 'default'
          },
        }

        clock = sinon.useFakeTimers({
          toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
        })

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

          sinon.assert.calledWithMatch(Client, {
            metricsProxyUrl: new URL('http://localhost:8126'),
            host: 'localhost',
            tags: [
              'str:bar',
              'invalid:t_e_s_t5-:./',
            ],
          })
        })

        it('it should initialize the Dogstatsd client with an IPv6 URL', function () {
          config.hostname = '::1'

          runtimeMetrics.stop()
          runtimeMetrics.start(config)

          sinon.assert.calledWithMatch(Client, {
            metricsProxyUrl: new URL('http://[::1]:8126'),
            host: 'localhost',
            tags: [
              'str:bar',
              'invalid:t_e_s_t5-:./',
            ],
          })
        })

        it('should include process tags when propagateProcessTags is enabled', function () {
          config.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED = true

          runtimeMetrics.stop()
          runtimeMetrics.start(config)

          const call = Client.lastCall
          const tags = call.args[0].tags
          assert.ok(tags.some(tag => tag.startsWith('entrypoint.type:')), 'expected entrypoint.type tag')
        })

        it('should not include process tags when propagateProcessTags is disabled', function () {
          config.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED = false

          runtimeMetrics.stop()
          runtimeMetrics.start(config)

          const call = Client.lastCall
          const tags = call.args[0].tags
          assert.ok(!tags.some(tag => tag.startsWith('entrypoint.')), 'expected no entrypoint tags')
        })

        it('should start collecting runtimeMetrics every 10 seconds', async () => {
          runtimeMetrics.stop()
          runtimeMetrics.start(config)

          client.gauge.resetHistory()
          client.increment.resetHistory()
          client.histogram.resetHistory()

          createGarbage()
          createGarbage()

          // Wait for GC observer to trigger.
          const startTime = Date.now()
          const waitTime = 200 + (nativeMetrics ? 0 : 200)
          let iterations = 0
          while (Date.now() - startTime < waitTime) {
            // Need ticks for the event loop delay
            if (iterations++ % 10000 === 0) {
              await setTimeout(1)
              clock.tick(1)
            }
          }

          global.gc()

          await setImmediate()
          await setImmediate()

          clock.tick(10000 - waitTime)

          const isFiniteNumber = sinon.match((value) => {
            return value > 0 && Number.isFinite(value)
          })

          const isIntegerNumber = sinon.match((value) => {
            return value > 0 && Number.isInteger(value)
          })
          const isGC95Percentile = sinon.match((value) => {
            return value >= 1e5 && value < 1e8 // In Nanoseconds. 0.1ms to 100ms.
          })
          const isHeapSpace = sinon.match((metricName) => {
            return /^heap_space:[a-z_]+$/.test(metricName)
          })

          // These return percentages as strings and are tested later.
          sinon.assert.calledWith(client.gauge, 'runtime.node.cpu.user')
          sinon.assert.calledWith(client.gauge, 'runtime.node.cpu.system')
          sinon.assert.calledWith(client.gauge, 'runtime.node.cpu.total')

          sinon.assert.calledWith(client.gauge, 'runtime.node.mem.rss', isFiniteNumber)
          sinon.assert.calledWith(client.gauge, 'runtime.node.mem.heap_total', isFiniteNumber)
          sinon.assert.calledWith(client.gauge, 'runtime.node.mem.heap_used', isFiniteNumber)

          sinon.assert.calledWith(client.gauge, 'runtime.node.process.uptime')

          sinon.assert.calledWith(client.gauge, 'runtime.node.heap.total_heap_size', isFiniteNumber)
          sinon.assert.calledWith(client.gauge, 'runtime.node.heap.total_heap_size_executable', isFiniteNumber)
          sinon.assert.calledWith(client.gauge, 'runtime.node.heap.total_physical_size', isFiniteNumber)
          sinon.assert.calledWith(client.gauge, 'runtime.node.heap.total_available_size', isFiniteNumber)
          sinon.assert.calledWith(client.gauge, 'runtime.node.heap.total_heap_size', isFiniteNumber)
          sinon.assert.calledWith(client.gauge, 'runtime.node.heap.heap_size_limit', isFiniteNumber)

          sinon.assert.calledWith(client.gauge, 'runtime.node.heap.malloced_memory', isFiniteNumber)
          sinon.assert.calledWith(client.gauge, 'runtime.node.heap.peak_malloced_memory', isFiniteNumber)

          sinon.assert.calledWith(client.gauge, 'runtime.node.event_loop.delay.max', isFiniteNumber)
          sinon.assert.calledWith(client.gauge, 'runtime.node.event_loop.delay.min', sinon.match((value) => {
            return value >= 0 && Number.isFinite(value)
          }))
          sinon.assert.calledWith(client.increment, 'runtime.node.event_loop.delay.sum', isFiniteNumber)
          sinon.assert.calledWith(client.gauge, 'runtime.node.event_loop.delay.avg', isFiniteNumber)
          if (nativeMetrics) {
            sinon.assert.calledWith(client.gauge, 'runtime.node.event_loop.delay.median', isFiniteNumber)
          } else {
            sinon.assert.neverCalledWith(client.gauge, 'runtime.node.event_loop.delay.median')
          }
          sinon.assert.calledWith(client.gauge, 'runtime.node.event_loop.delay.95percentile', isFiniteNumber)
          sinon.assert.calledWith(client.increment, 'runtime.node.event_loop.delay.count', isIntegerNumber)

          sinon.assert.calledWith(client.gauge, 'runtime.node.event_loop.utilization', isFiniteNumber)
          sinon.assert.calledWith(client.gauge, 'runtime.node.gc.pause.max', isFiniteNumber)
          sinon.assert.calledWith(client.gauge, 'runtime.node.gc.pause.min', isFiniteNumber)
          sinon.assert.calledWith(client.increment, 'runtime.node.gc.pause.sum', isFiniteNumber)
          sinon.assert.calledWith(client.gauge, 'runtime.node.gc.pause.avg', isFiniteNumber)
          sinon.assert.calledWith(client.gauge, 'runtime.node.gc.pause.median', isFiniteNumber)
          sinon.assert.calledWith(client.gauge, 'runtime.node.gc.pause.95percentile', isFiniteNumber)
          sinon.assert.calledWith(client.increment, 'runtime.node.gc.pause.count', isIntegerNumber)
          sinon.assert.calledWith(client.gauge, 'runtime.node.gc.pause.by.type.max', isFiniteNumber)
          sinon.assert.calledWith(client.gauge, 'runtime.node.gc.pause.by.type.min', isFiniteNumber)
          sinon.assert.calledWith(client.increment, 'runtime.node.gc.pause.by.type.sum', isFiniteNumber)
          sinon.assert.calledWith(client.gauge, 'runtime.node.gc.pause.by.type.avg', isFiniteNumber)
          sinon.assert.calledWith(client.gauge, 'runtime.node.gc.pause.by.type.median', isFiniteNumber)
          sinon.assert.calledWith(client.gauge, 'runtime.node.gc.pause.by.type.95percentile', isGC95Percentile)
          sinon.assert.calledWith(client.increment, 'runtime.node.gc.pause.by.type.count', isIntegerNumber)
          sinon.assert.calledWith(client.increment,
            'runtime.node.gc.pause.by.type.count', sinon.match.any, sinon.match(val => {
              return val && /^gc_type:[a-z_]+$/.test(val[0])
            })
          )

          sinon.assert.calledWith(client.gauge, 'runtime.node.heap.size.by.space', isFiniteNumber, isHeapSpace)
          sinon.assert.calledWith(client.gauge, 'runtime.node.heap.used_size.by.space', isFiniteNumber, isHeapSpace)
          sinon.assert.calledWith(
            client.gauge,
            'runtime.node.heap.available_size.by.space',
            isFiniteNumber,
            isHeapSpace
          )
          sinon.assert.calledWith(client.gauge, 'runtime.node.heap.physical_size.by.space', isFiniteNumber, isHeapSpace)

          sinon.assert.called(client.flush)
        })

        it('should collect individual metrics only once every 10 seconds', async () => {
          runtimeMetrics.stop()
          runtimeMetrics.start(config)

          global.gc()

          // Wait for GC observer to trigger.
          await setImmediate()
          await setImmediate()

          clock.tick(60 * 60 * 1000)

          // If a metric is leaking, it will leak exponentially because it will
          // be sent one more time each flush, in addition to the previous
          // flushes that also had the metric multiple times in them, so after
          // 1 hour even if a single metric is leaking it would get over
          // 64980 calls on its own without any other metric. A slightly lower
          // value is used here to be on the safer side.
          assert.ok(client.gauge.callCount < 60000, `Expected ${client.gauge.callCount} < 60000`)
          assert.ok(client.increment.callCount < 60000, `Expected ${client.increment.callCount} < 60000`)
        })

        it('should handle configuration changes correctly', async () => {
          // Test with GC disabled
          const configWithoutGC = { ...config, runtimeMetrics: { ...config.runtimeMetrics, gc: false } }
          runtimeMetrics.stop()
          runtimeMetrics.start(configWithoutGC)

          createGarbage()

          // Wait for event loop delay observer to trigger.
          let startTime = Date.now()
          const waitTime = 60
          while (Date.now() - startTime < waitTime) {
            // Need ticks for the event loop delay
            await setTimeout(1)
            clock.tick(1)
          }
          global.gc()
          await setTimeout(1)
          clock.tick(10000 - waitTime)
          // Should still collect basic metrics
          sinon.assert.calledWith(client.gauge, 'runtime.node.mem.rss')
          sinon.assert.calledWith(client.gauge, 'runtime.node.cpu.user')
          sinon.assert.calledWith(client.gauge, 'runtime.node.event_loop.utilization')
          sinon.assert.calledWith(client.gauge, 'runtime.node.event_loop.delay.95percentile')
          sinon.assert.neverCalledWith(client.gauge, 'runtime.node.gc.pause.95percentile')

          // Test with event loop disabled
          const configWithoutEL = { ...config, runtimeMetrics: { ...config.runtimeMetrics, eventLoop: false } }
          // Calling start again should stop any former metric collection
          runtimeMetrics.start(configWithoutEL)
          client.gauge.resetHistory()

          createGarbage()

          // Wait for GC observer to trigger.
          startTime = Date.now()
          while (Date.now() - startTime < waitTime) {
            // Need ticks for the event loop delay
            await setTimeout(1)
            clock.tick(1)
          }
          global.gc()
          await setTimeout(1)
          clock.tick(10000 - waitTime)

          // Should still collect other metrics
          sinon.assert.calledWith(client.gauge, 'runtime.node.mem.rss')
          sinon.assert.calledWith(client.gauge, 'runtime.node.cpu.user')
          sinon.assert.calledWith(client.gauge, 'runtime.node.gc.pause.95percentile')
          sinon.assert.neverCalledWith(client.gauge, 'runtime.node.event_loop.utilization')
          sinon.assert.neverCalledWith(client.gauge, 'runtime.node.event_loop.delay.95percentile')
        })

        it('should not load native metrics when native is false, even if eventLoop or gc are enabled', () => {
          // Stop the default runtimeMetrics instance started in beforeEach
          runtimeMetrics.stop()

          const nativeMetricsStart = sinon.spy()
          const nativeMetricsModule = {
            start: nativeMetricsStart,
            stop: sinon.spy(),
            stats: sinon.stub().returns({ cpu: { user: 0, system: 0 }, heap: { spaces: [] }, eventLoop: {}, gc: {} }),
          }

          const localClient = {
            gauge: sinon.spy(),
            increment: sinon.spy(),
            histogram: sinon.spy(),
            flush: sinon.spy(),
          }

          const LocalClient = sinon.spy(function () {
            return {
              gauge: localClient.gauge,
              increment: localClient.increment,
              histogram: localClient.histogram,
              flush: localClient.flush,
            }
          })
          LocalClient.generateClientConfig = DogStatsDClient.generateClientConfig

          const localRuntimeMetrics = proxyquire('../src/runtime_metrics/runtime_metrics', {
            '../dogstatsd': {
              DogStatsDClient: LocalClient,
            },
            '@datadog/native-metrics': nativeMetricsModule,
          })

          const configNativeDisabled = {
            ...config,
            runtimeMetrics: { ...config.runtimeMetrics, eventLoop: true, gc: true, native: false },
          }

          localRuntimeMetrics.start(configNativeDisabled)

          // Native metrics should not have been started despite eventLoop and gc being enabled
          sinon.assert.notCalled(nativeMetricsStart)

          // Should still collect basic metrics via the JS fallback path
          clock.tick(10000)
          sinon.assert.calledWith(localClient.gauge, 'runtime.node.mem.rss')
          sinon.assert.calledWith(localClient.gauge, 'runtime.node.cpu.user')

          localRuntimeMetrics.stop()
        })
      })

      describe('Event Loop Utilization', () => {
        it('should calculate utilization correctly with delta values', () => {
          const firstElu = { idle: 80000000, active: 20000000, utilization: 0.2 }
          const secondElu = { idle: 100000000, active: 80000000, utilization: 0.4444444444444444 }
          let diff = performance.eventLoopUtilization(firstElu, secondElu)
          assert.strictEqual(diff.utilization, 0.75)
          const thirdElu = { idle: 200000000, active: 80000000, utilization: 0.2857142857142857 }
          diff = performance.eventLoopUtilization(secondElu, thirdElu)
          assert.strictEqual(diff.utilization, -0)

          const eventLoopUtilizationStub = sinon.stub(performance, 'eventLoopUtilization')
            .onFirstCall().returns(firstElu)
            .onSecondCall().returns(secondElu)
            .onThirdCall().returns(thirdElu)

          clock.tick(10000) // First collection
          clock.tick(10000) // Second collection with delta
          clock.tick(10000) // Second collection with delta

          eventLoopUtilizationStub.restore()

          const eluCalls = client.gauge.getCalls().filter(call =>
            call.args[0] === 'runtime.node.event_loop.utilization'
          )

          assert.strictEqual(eluCalls.length, 3)
          assert.strictEqual(eluCalls[0].args[1], 0.2)
          assert.strictEqual(eluCalls[1].args[1], 0.75)
          assert.strictEqual(eluCalls[2].args[1], 0)
        })
      })

      describe('CPU Usage Calculations', () => {
        it('should report CPU percentages within valid ranges', () => {
          const startCpuUsage = process.cpuUsage()
          const startTime = Date.now()
          const startPerformanceNow = performance.now()
          let iterations = 0
          let ticks = 0
          while (Date.now() - startTime < 100) {
            iterations++
            if (iterations % 1000000 === 0) {
              clock.tick(1)
              ticks++
            }
          }
          const cpuUsage = process.cpuUsage()
          const cpuUsageStub = sinon.stub(process, 'cpuUsage').returns(cpuUsage)
          const performanceNowStub = sinon.stub(performance, 'now').returns(startPerformanceNow + 10000)
          clock.tick(10000 - ticks)
          performanceNowStub.restore()
          cpuUsageStub.restore()

          const timeDivisor = 100_000 // Microseconds * 100 for percent

          const cpuMetrics = new Map([[
            'runtime.node.cpu.user',
            Number(((cpuUsage.user - startCpuUsage.user) / timeDivisor).toFixed(2)),
          ], [
            'runtime.node.cpu.system',
            Number(((cpuUsage.system - startCpuUsage.system) / timeDivisor).toFixed(2)),
          ], [
            'runtime.node.cpu.total',
            Number((
              ((cpuUsage.user - startCpuUsage.user) + (cpuUsage.system - startCpuUsage.system)) / timeDivisor
            ).toFixed(2)),
          ]])

          let userPercent = 0
          let systemPercent = 0
          let totalPercent = 0

          for (const call of client.gauge.getCalls()) {
            const metric = call.args[0]
            const expected = cpuMetrics.get(metric)
            cpuMetrics.delete(metric)
            if (expected !== undefined) {
              const stringValue = call.args[1]
              assert.match(stringValue, /^\d+(\.\d{1,2})?$/)
              const number = Number(stringValue)
              if (metric === 'runtime.node.cpu.user') {
                assert(
                  number >= 1,
                  `${metric} sanity check failed (increase CPU load above with more ticks): ${number}`
                )
                userPercent = number
              }
              if (metric === 'runtime.node.cpu.system') {
                assert(number >= 0 && number <= 5, `${metric} sanity check failed: ${number}`)
                systemPercent = number
              }
              if (metric === 'runtime.node.cpu.total') {
                assert(
                  // Subtracting 0.1 for time-window/baseline alignment numbers and due to rounding issues.
                  number >= expected - 0.1 && number <= expected + 1,
                  `${metric} sanity check failed (increase CPU load above with more ticks): ${number} ${expected}`
                )
                totalPercent = number
              }
              const epsilon = os.platform() === 'win32' ? 1.5 : 0.5
              assert(number - expected < epsilon, `${metric} sanity check failed: ${number} ${expected}`)
            }
          }

          assert.strictEqual(cpuMetrics.size, 0, `All CPU metrics should be matched, missing ${[...cpuMetrics.keys()]}`)

          const totalDiff = Math.abs(totalPercent - userPercent - systemPercent)
          assert(totalDiff <= 0.03, `Total CPU percentage sanity check failed: ${totalDiff} > 0.03`)
        })
      })

      describe('Memory and Heap Metrics', () => {
        it('should ensure heap_used <= heap_total', () => {
          clock.tick(10000)

          const heapUsedCalls = client.gauge.getCalls().filter(call => call.args[0] === 'runtime.node.mem.heap_used')
          const heapTotalCalls = client.gauge.getCalls().filter(call => call.args[0] === 'runtime.node.mem.heap_total')

          assert.strictEqual(heapUsedCalls.length, 1)
          assert.strictEqual(heapTotalCalls.length, 1)

          const heapUsed = heapUsedCalls[0].args[1]
          const heapTotal = heapTotalCalls[0].args[1]

          assert(heapUsed <= heapTotal, `Expected ${heapUsed} <= ${heapTotal}`)
        })
      })

      describe('Process Uptime', () => {
        it('should show increasing uptime over time', () => {
          // On linux performance.now() would return a negative value due to the mocked time.
          // This is a workaround to ensure the test is deterministic.
          const startPerformanceNow = Math.max(performance.now(), Math.random() * 1_000_000)
          const nowStub = sinon.stub(performance, 'now').returns(startPerformanceNow)
          clock.tick(10000)
          nowStub.restore()
          const firstUptimeCalls = client.gauge.getCalls()
            .filter(call => call.args[0] === 'runtime.node.process.uptime')
          const firstUptime = firstUptimeCalls[0].args[1]

          client.gauge.resetHistory()
          const nowStub2 = sinon.stub(performance, 'now').returns(startPerformanceNow + 10_000)
          clock.tick(10000) // Advance another 10 seconds
          nowStub2.restore()

          let nextUptimeCall = client.gauge.getCalls().filter(call => call.args[0] === 'runtime.node.process.uptime')
          assert.strictEqual(nextUptimeCall.length, 1)
          let nextUptime = nextUptimeCall[0].args[1]

          // Uptime should be 10 seconds more
          assert.strictEqual(
            nextUptime - firstUptime,
            10,
            `Uptime diff should be 10 seconds, got ${nextUptime} - ${firstUptime}, start: ${startPerformanceNow}`
          )
          client.gauge.resetHistory()

          const nowStub3 = sinon.stub(performance, 'now').returns(startPerformanceNow + 20_000)
          clock.tick(10000) // Advance another 10 seconds
          nowStub3.restore()

          nextUptimeCall = client.gauge.getCalls().filter(call => call.args[0] === 'runtime.node.process.uptime')
          assert.strictEqual(nextUptimeCall.length, 1)
          nextUptime = nextUptimeCall[0].args[1]

          // Uptime should be 10 seconds more
          assert.strictEqual(
            nextUptime - firstUptime,
            20,
            `Uptime diff should be 20 seconds, got ${nextUptime} - ${firstUptime}, start: ${startPerformanceNow}`
          )
        })
      })

      describe('Metric Consistency and Reliability', () => {
        it('should produce consistent metrics across multiple flushes', () => {
          runtimeMetrics.start(config)

          const flushCount = 3

          for (let i = 0; i < flushCount; i++) {
            client.gauge.resetHistory()
            client.increment.resetHistory()
            client.histogram.resetHistory()

            clock.tick(10000)

            const metrics = client.gauge.getCalls().reduce((acc, call) => {
              acc.set(call.args[0], call.args[1])
              return acc
            }, new Map())

            // If event loop count or gc count is zero, the metrics are not reported.
            assert.strictEqual(metrics.size, 22)
            assert.strictEqual(client.histogram.getCalls().length, 0)
            assert.strictEqual(client.increment.getCalls().length, 0)
          }
        })

        it('should report expected memory usage values', () => {
          const stats = process.memoryUsage()
          const totalmem = os.totalmem()
          const freemem = os.freemem()

          sinon.stub(process, 'memoryUsage').returns(stats)
          sinon.stub(os, 'totalmem').returns(totalmem)
          sinon.stub(os, 'freemem').returns(freemem)

          clock.tick(10000)

          sinon.restore()

          const metrics = client.gauge.getCalls().reduce((acc, call) => {
            acc[call.args[0]] = call.args[1]
            return acc
          }, {})

          assertObjectContains(metrics, {
            'runtime.node.mem.heap_total': stats.heapTotal,
            'runtime.node.mem.heap_used': stats.heapUsed,
            'runtime.node.mem.rss': stats.rss,
            'runtime.node.mem.total': totalmem,
            'runtime.node.mem.free': freemem,
            'runtime.node.mem.external': stats.external,
          })
        })
      })

      describe('when started', () => {
        describe('stop', () => {
          it('should stop collecting runtimeMetrics every 10 seconds', () => {
            runtimeMetrics.stop()

            clock.tick(10000)

            sinon.assert.notCalled(client.gauge)
          })
        })

        describe('histogram', () => {
          it('should add a record to a histogram', () => {
            runtimeMetrics.histogram('test', 0)
            runtimeMetrics.histogram('test', 1)
            runtimeMetrics.histogram('test', 2)
            runtimeMetrics.histogram('test', 3)

            clock.tick(10000)

            sinon.assert.calledWith(client.gauge, 'test.max', 3)
            sinon.assert.calledWith(client.gauge, 'test.min', 0)
            sinon.assert.calledWith(client.increment, 'test.sum', 6)
            sinon.assert.calledWith(client.increment, 'test.total', 6)
            sinon.assert.calledWith(client.gauge, 'test.avg', 1.5)
            sinon.assert.calledWith(client.gauge, 'test.median', sinon.match.number)
            sinon.assert.calledWith(client.gauge, 'test.95percentile', sinon.match.number)
            sinon.assert.calledWith(client.increment, 'test.count', 4)
          })
        })

        describe('increment', () => {
          it('should increment a gauge', () => {
            runtimeMetrics.increment('test')

            clock.tick(10000)

            sinon.assert.calledWith(client.gauge, 'test', 1)
          })

          it('should increment a gauge with a tag', () => {
            runtimeMetrics.increment('test', 'foo:bar')

            clock.tick(10000)

            sinon.assert.calledWith(client.gauge, 'test', 1, ['foo:bar'])
          })

          it('should increment a monotonic counter', () => {
            runtimeMetrics.increment('test', true)

            clock.tick(10000)

            sinon.assert.calledWith(client.increment, 'test', 1)

            client.increment.resetHistory()

            clock.tick(10000)

            sinon.assert.neverCalledWith(client.increment, 'test')
          })

          it('should increment a monotonic counter with a tag', () => {
            runtimeMetrics.increment('test', 'foo:bar', true)

            clock.tick(10000)

            sinon.assert.calledWith(client.increment, 'test', 1, ['foo:bar'])

            client.increment.resetHistory()

            clock.tick(10000)

            sinon.assert.neverCalledWith(client.increment, 'test')
          })
        })

        describe('decrement', () => {
          it('should increment a gauge', () => {
            runtimeMetrics.decrement('test')

            clock.tick(10000)

            sinon.assert.calledWith(client.gauge, 'test', -1)
          })

          it('should decrement a gauge with a tag', () => {
            runtimeMetrics.decrement('test', 'foo:bar')

            clock.tick(10000)

            sinon.assert.calledWith(client.gauge, 'test', -1, ['foo:bar'])
          })
        })

        describe('gauge', () => {
          it('should set a gauge', () => {
            runtimeMetrics.gauge('test', 10)

            clock.tick(10000)

            sinon.assert.calledWith(client.gauge, 'test', 10)
          })

          it('should set a gauge with a tag', () => {
            runtimeMetrics.gauge('test', 10, 'foo:bar')

            clock.tick(10000)

            sinon.assert.calledWith(client.gauge, 'test', 10, ['foo:bar'])
          })
        })

        describe('boolean', () => {
          it('should set a gauge', () => {
            runtimeMetrics.boolean('test', true)

            clock.tick(10000)

            sinon.assert.calledWith(client.gauge, 'test', 1)
          })

          it('should set a gauge with a tag', () => {
            runtimeMetrics.boolean('test', true, 'foo:bar')

            clock.tick(10000)

            sinon.assert.calledWith(client.gauge, 'test', 1, ['foo:bar'])
          })
        })
      })
    })
  })
})

// OTel-native runtime metrics path. Names/types/units come from
// open-telemetry/semantic-conventions: model/{v8js,nodejs}/metrics.yaml.
describe('otlp_runtime_metrics', () => {
  const SPEC = {
    'v8js.memory.heap.used': { type: 'updowncounter', unit: 'By' },
    'v8js.memory.heap.limit': { type: 'updowncounter', unit: 'By' },
    'v8js.memory.heap.space.available_size': { type: 'updowncounter', unit: 'By' },
    'v8js.memory.heap.space.physical_size': { type: 'updowncounter', unit: 'By' },
    'v8js.memory.heap.space.size': { type: 'updowncounter', unit: 'By' },
    'v8js.gc.duration': { type: 'histogram', unit: 's' },
    'v8js.resource.active': { type: 'gauge', unit: '{resource}' },
    'nodejs.eventloop.delay.min': { type: 'gauge', unit: 's' },
    'nodejs.eventloop.delay.max': { type: 'gauge', unit: 's' },
    'nodejs.eventloop.delay.mean': { type: 'gauge', unit: 's' },
    'nodejs.eventloop.delay.stddev': { type: 'gauge', unit: 's' },
    'nodejs.eventloop.delay.p50': { type: 'gauge', unit: 's' },
    'nodejs.eventloop.delay.p90': { type: 'gauge', unit: 's' },
    'nodejs.eventloop.delay.p99': { type: 'gauge', unit: 's' },
    'nodejs.eventloop.time': { type: 'observable-counter', unit: 's' },
    'nodejs.eventloop.utilization': { type: 'gauge', unit: '1' },
  }

  // Captures the GC observer instance so tests can fire fake entries instead of waiting on real GC.
  class FakePerformanceObserver {
    constructor (callback) {
      this.callback = callback
      FakePerformanceObserver.instances.push(this)
    }

    observe () {}
    disconnect () {}
  }
  FakePerformanceObserver.instances = []

  let otlpMetrics
  let createdInstruments
  let callbacks
  let records
  let batchCallbacks

  beforeEach(() => {
    createdInstruments = {}
    callbacks = {}
    records = {}
    batchCallbacks = []
    FakePerformanceObserver.instances = []

    function makeFactory (type) {
      return (name, opts) => {
        const instrument = {
          name,
          type,
          opts,
          addCallback (cb) {
            if (!callbacks[name]) callbacks[name] = []
            callbacks[name].push(cb)
          },
          removeCallback (cb) {
            const list = callbacks[name]
            if (!list) return
            const idx = list.indexOf(cb)
            if (idx !== -1) list.splice(idx, 1)
          },
          record (value, attrs) {
            if (!records[name]) records[name] = []
            records[name].push({ v: value, a: attrs })
          },
        }
        createdInstruments[name] = instrument
        return instrument
      }
    }

    const mockMeter = {
      createObservableGauge: makeFactory('gauge'),
      createObservableUpDownCounter: makeFactory('updowncounter'),
      createObservableCounter: makeFactory('observable-counter'),
      createHistogram: makeFactory('histogram'),
      addBatchObservableCallback (cb, observables) {
        batchCallbacks.push({ cb, observables })
      },
      removeBatchObservableCallback (cb) {
        const idx = batchCallbacks.findIndex(r => r.cb === cb)
        if (idx !== -1) batchCallbacks.splice(idx, 1)
      },
    }

    const realPerfHooks = require('node:perf_hooks')

    otlpMetrics = proxyquire.noCallThru()('../src/runtime_metrics/otlp_runtime_metrics', {
      '@opentelemetry/api': {
        metrics: { getMeterProvider: () => ({ getMeter: () => mockMeter }) },
      },
      '../log': { debug () {}, error () {} },
      'node:perf_hooks': {
        performance: realPerfHooks.performance,
        monitorEventLoopDelay: realPerfHooks.monitorEventLoopDelay,
        PerformanceObserver: FakePerformanceObserver,
        constants: realPerfHooks.constants,
      },
    })
  })

  // Drives every registered batch callback and returns a Map<instrument, [{v, a}]>.
  function fireBatchCallbacks () {
    const observed = new Map()
    for (const { cb, observables } of batchCallbacks) {
      const allowed = new Set(observables)
      cb({
        observe: (instrument, value, attrs = {}) => {
          if (!allowed.has(instrument)) return
          if (!observed.has(instrument)) observed.set(instrument, [])
          observed.get(instrument).push({ v: value, a: attrs })
        },
      })
    }
    return observed
  }

  afterEach(() => {
    otlpMetrics.stop()
  })

  const BATCH_OBSERVED = new Set([
    'v8js.memory.heap.used', 'v8js.memory.heap.limit',
    'v8js.memory.heap.space.available_size', 'v8js.memory.heap.space.physical_size', 'v8js.memory.heap.space.size',
  ])

  it('registers all OTel-native metrics with spec-correct types and units', () => {
    otlpMetrics.start({ runtimeMetrics: { eventLoop: true } })

    assert.deepStrictEqual(Object.keys(createdInstruments).sort(), Object.keys(SPEC).slice().sort())
    assert.strictEqual(batchCallbacks.length, 1, 'heap stats should register exactly one batch callback')

    for (const [name, { type, unit }] of Object.entries(SPEC)) {
      const inst = createdInstruments[name]
      assert.strictEqual(inst.type, type, `${name} should be ${type}`)
      assert.strictEqual(inst.opts.unit, unit, `${name} unit should be ${unit}`)
      if (type === 'histogram' || BATCH_OBSERVED.has(name)) {
        assert.strictEqual(callbacks[name], undefined,
          `${name} should not register a per-instrument observable callback`)
      } else {
        assert.ok(callbacks[name]?.length, `${name} should register a per-instrument callback`)
      }
      assert.doesNotMatch(name, /^runtime\.node\./, `${name} should not use DD-proprietary naming`)
    }
  })

  it('observes positive values and emits required attributes', () => {
    otlpMetrics.start({ runtimeMetrics: { eventLoop: true } })

    const observed = fireBatchCallbacks()

    const heapUsed = observed.get(createdInstruments['v8js.memory.heap.used']) ?? []
    assert.ok(heapUsed.reduce((sum, e) => sum + e.v, 0) > 0, 'heap used should be positive')
    assert.ok(heapUsed.every(e => typeof e.a?.['v8js.heap.space.name'] === 'string'),
      'heap.used should carry v8js.heap.space.name')

    const heapLimit = observed.get(createdInstruments['v8js.memory.heap.limit']) ?? []
    assert.ok(heapLimit[0]?.v > 0, 'heap limit should be positive')

    const spaceSizes = observed.get(createdInstruments['v8js.memory.heap.space.size']) ?? []
    assert.ok(spaceSizes.some(e => e.v > 0 && typeof e.a?.['v8js.heap.space.name'] === 'string'),
      'heap.space.size should observe per-space values with a space name attribute')

    const spaces = (observed.get(createdInstruments['v8js.memory.heap.space.available_size']) ?? [])
      .map(e => e.a?.['v8js.heap.space.name'])
    assert.ok(spaces.includes('new_space') && spaces.includes('old_space'),
      'heap space metrics should carry v8js.heap.space.name')

    const eluTimePoints = []
    callbacks['nodejs.eventloop.time'][0]({
      observe: (v, a) => eluTimePoints.push({ v, state: a?.['nodejs.eventloop.state'] }),
    })
    assert.deepStrictEqual(eluTimePoints.map(e => e.state).sort(), ['active', 'idle'])

    for (const name of [
      'nodejs.eventloop.delay.min', 'nodejs.eventloop.delay.max', 'nodejs.eventloop.delay.mean',
    ]) {
      const points = []
      callbacks[name][0]({ observe: v => points.push(v) })
      assert.strictEqual(typeof points[0], 'number', `${name} should record a numeric value`)
    }

    const resourceCounts = []
    callbacks['v8js.resource.active'][0]({
      observe: (v, a) => resourceCounts.push({ v, type: a?.['v8js.resource.type'] }),
    })
    assert.ok(resourceCounts.length > 0, 'v8js.resource.active should observe at least one resource type')
    assert.ok(resourceCounts.every(e => e.v > 0 && typeof e.type === 'string'),
      'every v8js.resource.active observation should have a positive count and a type attribute')
  })

  it('records v8js.gc.duration in seconds with mapped v8js.gc.type attribute', () => {
    const { constants: perfConstants } = require('node:perf_hooks')
    otlpMetrics.start({ runtimeMetrics: { gc: true } })

    assert.strictEqual(FakePerformanceObserver.instances.length, 1, 'GC observer should be installed')
    const observer = FakePerformanceObserver.instances[0]

    // Covers every value of v8js.gc.type plus an unknown kind that should be dropped.
    // kind=2 is V8 MinorMarkSweep (Node 20+) — V8-internal, not in perf_hooks.constants.
    observer.callback({
      getEntries: () => [
        { duration: 5, kind: perfConstants.NODE_PERFORMANCE_GC_MINOR },
        { duration: 3, kind: 2 },
        { duration: 10, kind: perfConstants.NODE_PERFORMANCE_GC_MAJOR },
        { duration: 2, kind: perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL },
        { duration: 1, kind: perfConstants.NODE_PERFORMANCE_GC_WEAKCB },
        { duration: 99, kind: 999 },
      ],
    })

    assert.deepStrictEqual(records['v8js.gc.duration'], [
      { v: 0.005, a: { 'v8js.gc.type': 'minor' } },
      { v: 0.003, a: { 'v8js.gc.type': 'minor' } },
      { v: 0.01, a: { 'v8js.gc.type': 'major' } },
      { v: 0.002, a: { 'v8js.gc.type': 'incremental' } },
      { v: 0.001, a: { 'v8js.gc.type': 'weakcb' } },
    ])
  })

  it('skips gc.duration when runtimeMetrics.gc is false', () => {
    otlpMetrics.start({ runtimeMetrics: { gc: false } })
    assert.ok(!createdInstruments['v8js.gc.duration'], 'gc.duration should not be created when disabled')
    assert.strictEqual(FakePerformanceObserver.instances.length, 0, 'no GC observer should be installed')
  })

  it('fully unwinds partial initialization when an instrument factory throws', () => {
    let createdBeforeFailure = 0
    const throwingMeter = {
      createObservableGauge: (name, opts) => {
        createdBeforeFailure++
        if (name === 'v8js.resource.active') throw new Error('boom')
        return { name, opts, addCallback () {}, removeCallback () {} }
      },
      createObservableUpDownCounter: (name, opts) => {
        createdBeforeFailure++
        return { name, opts, addCallback () {}, removeCallback () {} }
      },
      createObservableCounter: (name, opts) => {
        createdBeforeFailure++
        return { name, opts, addCallback () {}, removeCallback () {} }
      },
      createHistogram: (name, opts) => ({ name, opts, addCallback () {}, removeCallback () {}, record () {} }),
      addBatchObservableCallback () {},
      removeBatchObservableCallback () {},
    }
    const errorLog = sinon.spy()
    const otlpMetricsFailing = proxyquire.noCallThru()('../src/runtime_metrics/otlp_runtime_metrics', {
      '@opentelemetry/api': {
        metrics: { getMeterProvider: () => ({ getMeter: () => throwingMeter }) },
      },
      '../log': { debug () {}, error: errorLog },
    })

    otlpMetricsFailing.start({ runtimeMetrics: {} })

    assert.ok(createdBeforeFailure > 0, 'sanity: some instruments were registered before the throw')
    assert.ok(errorLog.calledOnce, 'failure should be logged via log.error')
    assert.match(errorLog.firstCall.args[0], /Failed to start OTLP runtime metrics/)
    otlpMetricsFailing.stop()
  })

  it('skips event loop metrics when disabled and is restartable', () => {
    otlpMetrics.start({ runtimeMetrics: { eventLoop: false } })
    for (const name of Object.keys(SPEC)) {
      if (name.startsWith('nodejs.eventloop.')) {
        assert.ok(!createdInstruments[name], `${name} should not be created`)
      }
    }

    otlpMetrics.stop()
    for (const k of Object.keys(createdInstruments)) delete createdInstruments[k]
    otlpMetrics.start({ runtimeMetrics: { eventLoop: true } })
    assert.strictEqual(Object.keys(createdInstruments).length, Object.keys(SPEC).length,
      'should register every metric again after stop')
  })
})

// End-to-end through a real MeterProvider + PeriodicMetricReader + OtlpTransformer,
// asserting the wire shape (sum vs gauge) of every observable runtime metric.
describe('OTLP runtime metrics — pipeline flow', () => {
  const SUM_NONMONOTONIC = new Set([
    'v8js.memory.heap.used', 'v8js.memory.heap.limit',
    'v8js.memory.heap.space.available_size', 'v8js.memory.heap.space.physical_size',
    'v8js.memory.heap.space.size',
  ])
  const SUM_MONOTONIC = new Set([
    'nodejs.eventloop.time',
  ])
  const GAUGE_METRICS = new Set([
    'v8js.resource.active',
    'nodejs.eventloop.delay.min', 'nodejs.eventloop.delay.max', 'nodejs.eventloop.delay.mean',
    'nodejs.eventloop.delay.stddev', 'nodejs.eventloop.delay.p50',
    'nodejs.eventloop.delay.p90', 'nodejs.eventloop.delay.p99',
    'nodejs.eventloop.utilization',
  ])
  const OBSERVABLE_EXPECTED = [...SUM_NONMONOTONIC, ...SUM_MONOTONIC, ...GAUGE_METRICS]

  class CapturingExporter {
    constructor () { this.exports = [] }
    export (metricsMap, callback) {
      this.exports.push([...metricsMap.values()])
      if (typeof callback === 'function') callback()
    }
  }

  function collectWire () {
    const transformer = new OtlpTransformer({}, 'http/json')
    const wire = {}
    let scopeName
    for (const batch of exporter.exports) {
      const json = JSON.parse(transformer.transformMetrics(batch).toString())
      for (const rm of json.resourceMetrics) {
        for (const sm of rm.scopeMetrics) {
          scopeName = scopeName || sm.scope?.name
          for (const m of sm.metrics) {
            wire[m.name] = m
          }
        }
      }
    }
    return { wire, scopeName }
  }

  let reader
  let exporter

  beforeEach(() => {
    exporter = new CapturingExporter()
    reader = new PeriodicMetricReader(exporter, 60_000, 'DELTA', 1024)
    metrics.setGlobalMeterProvider(new MeterProvider({ reader }))
  })

  afterEach(() => {
    otlpRuntimeMetrics.stop()
    reader?.shutdown()
    metrics.disable()
  })

  // gc.duration histogram wire shape is covered by opentelemetry/metrics.spec.js;
  // the GC observer wiring + kind→type mapping is covered in the mock describe above.
  it('flushes every observable metric with correct wire shape (sum vs gauge) and scope name', () => {
    otlpRuntimeMetrics.start({ runtimeMetrics: { enabled: true, eventLoop: true, gc: false } })
    reader.forceFlush()

    const { wire, scopeName } = collectWire()

    assert.deepStrictEqual(Object.keys(wire).sort(), OBSERVABLE_EXPECTED.slice().sort())
    assert.strictEqual(scopeName, 'datadog.runtime_metrics')

    for (const name of OBSERVABLE_EXPECTED) {
      const m = wire[name]
      if (SUM_NONMONOTONIC.has(name)) {
        assert.ok('sum' in m, `${name} should serialize as sum`)
        assert.strictEqual(m.sum.isMonotonic, false, `${name} should be non-monotonic`)
      } else if (SUM_MONOTONIC.has(name)) {
        assert.ok('sum' in m, `${name} should serialize as sum`)
        assert.strictEqual(m.sum.isMonotonic, true, `${name} should be monotonic`)
      } else {
        assert.ok('gauge' in m, `${name} should serialize as gauge`)
      }
    }
  })
})
