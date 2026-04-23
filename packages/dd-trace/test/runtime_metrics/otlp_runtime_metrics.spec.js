'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire').noCallThru()

describe('otlp_runtime_metrics', () => {
  let otlpMetrics
  let mockMeter
  let mockMeterProvider
  let createdGauges
  let callbacks

  beforeEach(() => {
    createdGauges = {}
    callbacks = {}

    mockMeter = {
      createObservableGauge (name, opts) {
        const gauge = {
          name,
          opts,
          addCallback (cb) {
            if (!callbacks[name]) callbacks[name] = []
            callbacks[name].push(cb)
          },
        }
        createdGauges[name] = gauge
        return gauge
      },
    }

    mockMeterProvider = {
      getMeter (name) {
        return mockMeter
      },
    }

    otlpMetrics = proxyquire('../../src/runtime_metrics/otlp_runtime_metrics', {
      '@opentelemetry/api': {
        metrics: {
          getMeterProvider () {
            return mockMeterProvider
          },
        },
      },
      '../log': {
        debug () {},
        error () {},
      },
    })
  })

  afterEach(() => {
    otlpMetrics.stop()
  })

  it('should create exactly 13 OTel-native metric instruments', () => {
    otlpMetrics.start({ runtimeMetrics: { eventLoop: true } })

    const expectedMetrics = [
      'v8js.memory.heap.used',
      'v8js.memory.heap.limit',
      'v8js.memory.heap.space.available_size',
      'v8js.memory.heap.space.physical_size',
      'process.memory.usage',
      'process.cpu.utilization',
      'nodejs.eventloop.delay.min',
      'nodejs.eventloop.delay.max',
      'nodejs.eventloop.delay.mean',
      'nodejs.eventloop.delay.p50',
      'nodejs.eventloop.delay.p90',
      'nodejs.eventloop.delay.p99',
      'nodejs.eventloop.utilization',
    ]

    for (const name of expectedMetrics) {
      assert.ok(createdGauges[name], `${name} should be created`)
    }

    assert.equal(Object.keys(createdGauges).length, 13, 'should create exactly 13 instruments')

    // No DD-proprietary names should be present
    for (const name of Object.keys(createdGauges)) {
      assert.ok(!name.startsWith('runtime.node.'), `${name} should use OTel naming, not DD naming`)
    }
  })

  it('should use correct units on instruments', () => {
    otlpMetrics.start({ runtimeMetrics: {} })

    assert.equal(createdGauges['v8js.memory.heap.used'].opts.unit, 'By')
    assert.equal(createdGauges['process.memory.usage'].opts.unit, 'By')
    assert.equal(createdGauges['process.cpu.utilization'].opts.unit, '1')
  })

  it('should register addCallback on each instrument', () => {
    otlpMetrics.start({ runtimeMetrics: { eventLoop: true } })

    for (const name of Object.keys(createdGauges)) {
      assert.ok(callbacks[name] && callbacks[name].length > 0, `${name} should have a callback registered`)
    }
  })

  it('should observe positive values in callback', () => {
    otlpMetrics.start({ runtimeMetrics: {} })

    const heapObs = []
    callbacks['v8js.memory.heap.used'][0]({ observe (value, attrs) { heapObs.push({ value, attrs }) } })
    assert.ok(heapObs.length > 0, 'v8js.memory.heap.used should be observed')
    assert.ok(heapObs[0].value > 0, 'heap used should be positive')

    const memObs = []
    callbacks['process.memory.usage'][0]({ observe (value) { memObs.push(value) } })
    assert.ok(memObs[0] > 0, 'RSS should be positive')
  })

  it('should include v8js.heap.space.name attribute on heap space metrics', () => {
    otlpMetrics.start({ runtimeMetrics: {} })

    const observations = []
    callbacks['v8js.memory.heap.space.available_size'][0]({
      observe (value, attrs) { observations.push({ value, attrs }) },
    })

    assert.ok(observations.length > 0, 'should have heap space metrics')
    assert.ok(observations.some(m => m.attrs?.['v8js.heap.space.name'] === 'new_space'), 'should have new_space')
    assert.ok(observations.some(m => m.attrs?.['v8js.heap.space.name'] === 'old_space'), 'should have old_space')
  })

  it('should include process.cpu.state attribute on CPU metrics', () => {
    otlpMetrics.start({ runtimeMetrics: {} })

    // First call sets baseline
    callbacks['process.cpu.utilization'][0]({ observe () {} })

    // Second call produces delta
    const observations = []
    callbacks['process.cpu.utilization'][0]({
      observe (value, attrs) { observations.push({ value, attrs }) },
    })

    assert.ok(observations.length === 2, 'should have user and system CPU metrics')
    assert.ok(observations.some(m => m.attrs?.['process.cpu.state'] === 'user'), 'should have cpu.state=user')
    assert.ok(observations.some(m => m.attrs?.['process.cpu.state'] === 'system'), 'should have cpu.state=system')
  })

  it('should not create event loop metrics when disabled', () => {
    otlpMetrics.start({ runtimeMetrics: { eventLoop: false } })

    assert.ok(!createdGauges['nodejs.eventloop.delay.min'], 'event loop min should not be created')
    assert.ok(!createdGauges['nodejs.eventloop.delay.max'], 'event loop max should not be created')
    assert.ok(!createdGauges['nodejs.eventloop.delay.p90'], 'event loop p90 should not be created')
    assert.ok(!createdGauges['nodejs.eventloop.delay.p99'], 'event loop p99 should not be created')
    assert.ok(!createdGauges['nodejs.eventloop.utilization'], 'event loop utilization should not be created')
  })

  it('should clean up on stop', () => {
    otlpMetrics.start({ runtimeMetrics: {} })
    assert.ok(Object.keys(createdGauges).length > 0)

    otlpMetrics.stop()
    createdGauges = {}
    callbacks = {}
    otlpMetrics.start({ runtimeMetrics: {} })
    assert.ok(Object.keys(createdGauges).length > 0, 'should be able to restart')
  })
})
