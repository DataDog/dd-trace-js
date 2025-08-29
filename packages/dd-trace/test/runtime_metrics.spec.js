'use strict'

require('./setup/tap')
const { DogStatsDClient } = require('../src/dogstatsd')

const assert = require('node:assert')
const os = require('node:os')
const performance = require('node:perf_hooks').performance
const { setImmediate, setTimeout } = require('node:timers/promises')
const util = require('node:util')

const isWindows = os.platform() === 'win32'

const suiteDescribe = isWindows ? describe.skip : describe

function createGarbage (count = 50) {
  let last = {}
  const obj = last

  for (let i = 0; i < count; i++) {
    last.next = { circular: obj, last, obj: { a: 1, b: 2, c: true } }
    last = last.next
    last.map = new Map([['a', 1], ['b', 2], ['c', true]])
    obj[i] = last
  }

  return util.inspect(obj, { depth: Infinity })
}

function getPerformanceNow () {
  // On linux performance.now() would return a negative value due to the mocked time.
  // This is a workaround to ensure the test is deterministic.
  return Math.max(performance.now(), Math.round(Math.random() * 10000))
}

[true, false].forEach((nativeMetrics) => {
  describe(`runtimeMetrics ${nativeMetrics ? 'with' : 'without'} native metrics`, () => {
    suiteDescribe('runtimeMetrics (proxy)', () => {
      let runtimeMetrics
      let proxy
      let config

      beforeEach(() => {
        config = {
          runtimeMetrics: {
            enabled: false
          }
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
          decrement () {}
        })

        proxy = proxyquire('../src/runtime_metrics', {
          './runtime_metrics': runtimeMetrics
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

        expect(runtimeMetrics.start).to.not.have.been.called
        expect(runtimeMetrics.track).to.not.have.been.called
        expect(runtimeMetrics.boolean).to.not.have.been.called
        expect(runtimeMetrics.histogram).to.not.have.been.called
        expect(runtimeMetrics.count).to.not.have.been.called
        expect(runtimeMetrics.gauge).to.not.have.been.called
        expect(runtimeMetrics.increment).to.not.have.been.called
        expect(runtimeMetrics.decrement).to.not.have.been.called
        expect(runtimeMetrics.stop).to.not.have.been.called
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

        expect(runtimeMetrics.start).to.have.been.calledWith(config)
        expect(runtimeMetrics.track).to.have.been.called
        expect(runtimeMetrics.boolean).to.have.been.called
        expect(runtimeMetrics.histogram).to.have.been.called
        expect(runtimeMetrics.count).to.have.been.called
        expect(runtimeMetrics.gauge).to.have.been.called
        expect(runtimeMetrics.increment).to.have.been.called
        expect(runtimeMetrics.decrement).to.have.been.called
        expect(runtimeMetrics.stop).to.have.been.called
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

        expect(runtimeMetrics.start).to.have.been.calledOnce
        expect(runtimeMetrics.track).to.not.have.been.called
        expect(runtimeMetrics.boolean).to.not.have.been.called
        expect(runtimeMetrics.histogram).to.not.have.been.called
        expect(runtimeMetrics.count).to.not.have.been.called
        expect(runtimeMetrics.gauge).to.not.have.been.called
        expect(runtimeMetrics.increment).to.not.have.been.called
        expect(runtimeMetrics.decrement).to.not.have.been.called
        expect(runtimeMetrics.stop).to.have.been.calledOnce
      })
    })

    suiteDescribe('runtimeMetrics', () => {
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

        const proxiedObject = {
          '../dogstatsd': {
            DogStatsDClient: Client
          },
        }
        if (!nativeMetrics) {
          proxiedObject['@datadog/native-metrics'] = {
            start () {
              throw new Error('Native metrics are not supported in this environment')
            },
          }
        }

        runtimeMetrics = proxyquire('../src/runtime_metrics/runtime_metrics', proxiedObject)

        config = {
          hostname: 'localhost',
          port: '8126',
          dogstatsd: {
            hostname: 'localhost',
            port: 8125
          },
          runtimeMetrics: {
            enabled: true,
            eventLoop: true,
            gc: true
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

        it('should start collecting runtimeMetrics every 10 seconds', async () => {
          runtimeMetrics.stop()
          runtimeMetrics.start(config)

          client.gauge.resetHistory()
          client.increment.resetHistory()
          client.histogram.resetHistory()

          createGarbage()

          // Wait for GC observer to trigger.
          const startTime = Date.now()
          const waitTime = 100
          while (Date.now() - startTime < waitTime) {
            // Need ticks for the event loop delay
            await setTimeout(1)
            clock.tick(1)
          }

          global.gc()

          clock.tick(10000 - waitTime)

          const isFiniteNumber = sinon.match((value) => {
            return value > 0 && Number.isFinite(value)
          })

          const isIntegerNumber = sinon.match((value) => {
            return value > 0 && Number.isInteger(value)
          })
          const isGC95Percentile = sinon.match((value) => {
            return value >= 4e5 && value < 1e8 // In Nanoseconds. 0.4ms to 100ms.
          })

          // These return percentages as strings and are tested later.
          expect(client.gauge).to.have.been.calledWith('runtime.node.cpu.user')
          expect(client.gauge).to.have.been.calledWith('runtime.node.cpu.system')
          expect(client.gauge).to.have.been.calledWith('runtime.node.cpu.total')

          expect(client.gauge).to.have.been.calledWith('runtime.node.mem.rss', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.mem.heap_total', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.mem.heap_used', isFiniteNumber)

          expect(client.gauge).to.have.been.calledWith('runtime.node.process.uptime')

          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_heap_size', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_heap_size_executable', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_physical_size', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_available_size', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.total_heap_size', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.heap_size_limit', isFiniteNumber)

          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.malloced_memory', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.peak_malloced_memory', isFiniteNumber)

          expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.max', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.min', sinon.match((value) => {
            return value >= 0 && Number.isFinite(value)
          }))
          expect(client.increment).to.have.been.calledWith('runtime.node.event_loop.delay.sum', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.avg', isFiniteNumber)
          if (nativeMetrics) {
            expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.median', isFiniteNumber)
          } else {
            expect(client.gauge).to.not.have.been.calledWith('runtime.node.event_loop.delay.median')
          }
          expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.95percentile', isFiniteNumber)
          expect(client.increment).to.have.been.calledWith('runtime.node.event_loop.delay.count', isIntegerNumber)

          expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.utilization', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.max', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.min', isFiniteNumber)
          expect(client.increment).to.have.been.calledWith('runtime.node.gc.pause.sum', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.avg', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.median', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.95percentile', isFiniteNumber)
          expect(client.increment).to.have.been.calledWith('runtime.node.gc.pause.count', isIntegerNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.by.type.max', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.by.type.min', isFiniteNumber)
          expect(client.increment).to.have.been.calledWith('runtime.node.gc.pause.by.type.sum', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.by.type.avg', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.by.type.median', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.by.type.95percentile', isGC95Percentile)
          expect(client.increment).to.have.been.calledWith('runtime.node.gc.pause.by.type.count', isIntegerNumber)
          expect(client.increment).to.have.been.calledWith(
            'runtime.node.gc.pause.by.type.count', sinon.match.any, sinon.match(val => {
              return val && /^gc_type:[a-z_]+$/.test(val[0])
            })
          )

          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.size.by.space', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.used_size.by.space', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.available_size.by.space', isFiniteNumber)
          expect(client.gauge).to.have.been.calledWith('runtime.node.heap.physical_size.by.space', isFiniteNumber)

          expect(client.flush).to.have.been.called
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
          expect(client.gauge.callCount).to.be.lt(60000)
          expect(client.increment.callCount).to.be.lt(60000)
        })

        it('should handle configuration changes correctly', async () => {
          // Test with GC disabled
          const configWithoutGC = { ...config, runtimeMetrics: { ...config.runtimeMetrics, gc: false } }
          runtimeMetrics.stop()
          runtimeMetrics.start(configWithoutGC)

          createGarbage()

          // Wait for event loop delay observer to trigger.
          let startTime = Date.now()
          let waitTime = 60
          while (Date.now() - startTime < waitTime) {
            // Need ticks for the event loop delay
            await setTimeout(1)
            clock.tick(1)
          }
          global.gc()
          clock.tick(10000 - waitTime)
          // Should still collect basic metrics
          expect(client.gauge).to.have.been.calledWith('runtime.node.mem.rss')
          expect(client.gauge).to.have.been.calledWith('runtime.node.cpu.user')
          expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.utilization')
          expect(client.gauge).to.have.been.calledWith('runtime.node.event_loop.delay.95percentile')
          expect(client.gauge).to.not.have.been.calledWith('runtime.node.gc.pause.95percentile')

          // Test with event loop disabled
          const configWithoutEL = { ...config, runtimeMetrics: { ...config.runtimeMetrics, eventLoop: false } }
          // Calling start again should stop any former metric collection
          runtimeMetrics.start(configWithoutEL)
          client.gauge.resetHistory()

          createGarbage()

          // Wait for GC observer to trigger.
          startTime = Date.now()
          waitTime = 60
          while (Date.now() - startTime < waitTime) {
            // Need ticks for the event loop delay
            await setTimeout(1)
            clock.tick(1)
          }
          global.gc()
          clock.tick(10000 - waitTime)

          // Should still collect other metrics
          expect(client.gauge).to.have.been.calledWith('runtime.node.mem.rss')
          expect(client.gauge).to.have.been.calledWith('runtime.node.cpu.user')
          expect(client.gauge).to.have.been.calledWith('runtime.node.gc.pause.95percentile')
          expect(client.gauge).to.not.have.been.calledWith('runtime.node.event_loop.utilization')
          expect(client.gauge).to.not.have.been.calledWith('runtime.node.event_loop.delay.95percentile')
        })
      })

      describe('Event Loop Utilization', () => {
        afterEach(() => {
          performance.eventLoopUtilization.restore?.()
        })

        it('should calculate utilization correctly with delta values', () => {
          const firstElu = { idle: 80000000, active: 20000000, utilization: 0.2 }
          const secondElu = { idle: 100000000, active: 80000000, utilization: 0.4444444444444444 }
          let diff = performance.eventLoopUtilization(firstElu, secondElu)
          assert.strictEqual(diff.utilization, 0.75)
          const thirdElu = { idle: 200000000, active: 80000000, utilization: 0.2857142857142857 }
          diff = performance.eventLoopUtilization(secondElu, thirdElu)
          assert.strictEqual(diff.utilization, -0)

          sinon.stub(performance, 'eventLoopUtilization')
            .onFirstCall().returns(firstElu)
            .onSecondCall().returns(secondElu)
            .onThirdCall().returns(thirdElu)

          clock.tick(10000) // First collection
          clock.tick(10000) // Second collection with delta
          clock.tick(10000) // Second collection with delta

          performance.eventLoopUtilization.restore()

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
          const startPerformanceNow = getPerformanceNow()
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
          sinon.stub(process, 'cpuUsage').returns(cpuUsage)
          sinon.stub(performance, 'now').returns(startPerformanceNow + 10000)
          clock.tick(10000 - ticks)
          performance.now.restore()
          process.cpuUsage.restore()

          const timeDivisor = 100_000 // Microseconds * 100 for percent

          const cpuMetrics = new Map([[
            'runtime.node.cpu.user',
            Number(((cpuUsage.user - startCpuUsage.user) / timeDivisor).toFixed(2))
          ], [
            'runtime.node.cpu.system',
            Number(((cpuUsage.system - startCpuUsage.system) / timeDivisor).toFixed(2))
          ], [
            'runtime.node.cpu.total',
            Number((
              ((cpuUsage.user - startCpuUsage.user) + (cpuUsage.system - startCpuUsage.system)) / timeDivisor
            ).toFixed(2))
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
                assert(number >= 0 && number <= 1, `${metric} sanity check failed: ${number}`)
                systemPercent = number
              }
              if (metric === 'runtime.node.cpu.total') {
                assert(
                  number >= expected && number <= expected + 1,
                  `${metric} sanity check failed (increase CPU load above with more ticks): ${number} ${expected}`
                )
                totalPercent = number
              }
              assert(number - expected < 0.5, `${metric} sanity check failed: ${number} ${expected}`)
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

          assert(heapUsed <= heapTotal)
        })
      })

      describe('Process Uptime', () => {
        it('should show increasing uptime over time', () => {
          const startPerformanceNow = getPerformanceNow()
          clock.tick(10000)
          const firstUptimeCalls = client.gauge.getCalls()
            .filter(call => call.args[0] === 'runtime.node.process.uptime')
          const firstUptime = firstUptimeCalls[0].args[1]

          client.gauge.resetHistory()
          sinon.stub(performance, 'now').returns(startPerformanceNow + 10_000)
          clock.tick(10000) // Advance another 10 seconds
          performance.now.restore()

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

          sinon.stub(performance, 'now').returns(startPerformanceNow + 20_001)
          clock.tick(10000) // Advance another 10 seconds
          performance.now.restore()

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

          process.memoryUsage.restore()
          os.totalmem.restore()
          os.freemem.restore()

          const metrics = client.gauge.getCalls().reduce((acc, call) => {
            acc[call.args[0]] = call.args[1]
            return acc
          }, {})

          assert.strictEqual(metrics['runtime.node.mem.heap_total'], stats.heapTotal)
          assert.strictEqual(metrics['runtime.node.mem.heap_used'], stats.heapUsed)
          assert.strictEqual(metrics['runtime.node.mem.rss'], stats.rss)
          assert.strictEqual(metrics['runtime.node.mem.total'], totalmem)
          assert.strictEqual(metrics['runtime.node.mem.free'], freemem)
          assert.strictEqual(metrics['runtime.node.mem.external'], stats.external)
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
      })
    })
  })
})
