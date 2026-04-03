'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire').noCallThru()

describe('otlp_runtime_metrics', () => {
  let otlpMetrics
  let mockMeter
  let mockMeterProvider
  let observeCallbacks
  let createdGauges

  beforeEach(() => {
    observeCallbacks = []
    createdGauges = {}

    mockMeter = {
      createObservableGauge (name, opts) {
        const gauge = { name, opts }
        createdGauges[name] = gauge
        return gauge
      },
      addBatchObservableCallback (callback, observables) {
        observeCallbacks.push(callback)
        return {}
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

  it('should create OTel-native metric instruments', () => {
    otlpMetrics.start({ runtimeMetrics: { eventLoop: true } })

    // V8 heap metrics
    assert.ok(createdGauges['v8js.memory.heap.used'], 'v8js.memory.heap.used should be created')
    assert.ok(createdGauges['v8js.memory.heap.limit'], 'v8js.memory.heap.limit should be created')
    assert.ok(
      createdGauges['v8js.memory.heap.space.available_size'],
      'v8js.memory.heap.space.available_size should be created'
    )
    assert.ok(
      createdGauges['v8js.memory.heap.space.physical_size'],
      'v8js.memory.heap.space.physical_size should be created'
    )

    // Process metrics
    assert.ok(createdGauges['process.memory.usage'], 'process.memory.usage should be created')
    assert.ok(createdGauges['process.cpu.utilization'], 'process.cpu.utilization should be created')

    // Event loop metrics
    assert.ok(createdGauges['nodejs.eventloop.delay.min'], 'nodejs.eventloop.delay.min should be created')
    assert.ok(createdGauges['nodejs.eventloop.delay.max'], 'nodejs.eventloop.delay.max should be created')
    assert.ok(createdGauges['nodejs.eventloop.delay.mean'], 'nodejs.eventloop.delay.mean should be created')
    assert.ok(createdGauges['nodejs.eventloop.delay.p50'], 'nodejs.eventloop.delay.p50 should be created')
    assert.ok(createdGauges['nodejs.eventloop.delay.p90'], 'nodejs.eventloop.delay.p90 should be created')
    assert.ok(createdGauges['nodejs.eventloop.delay.p99'], 'nodejs.eventloop.delay.p99 should be created')
    assert.ok(
      createdGauges['nodejs.eventloop.utilization'],
      'nodejs.eventloop.utilization should be created'
    )
  })

  it('should use correct units on instruments', () => {
    otlpMetrics.start({ runtimeMetrics: {} })

    assert.equal(createdGauges['v8js.memory.heap.used'].opts.unit, 'By')
    assert.equal(createdGauges['process.memory.usage'].opts.unit, 'By')
    assert.equal(createdGauges['process.cpu.utilization'].opts.unit, '1')
  })

  it('should register a batch callback', () => {
    otlpMetrics.start({ runtimeMetrics: {} })
    assert.equal(observeCallbacks.length, 1, 'should register one batch callback')
  })

  it('should observe positive values in callback', () => {
    otlpMetrics.start({ runtimeMetrics: {} })

    const observations = []
    const observer = {
      observe (instrument, value, attrs) {
        observations.push({ name: instrument.name, value, attrs })
      },
    }

    // Execute the callback
    observeCallbacks[0](observer)

    // Check that heap metrics were observed with positive values
    const heapUsed = observations.find(o => o.name === 'v8js.memory.heap.used')
    assert.ok(heapUsed, 'v8js.memory.heap.used should be observed')
    assert.ok(heapUsed.value > 0, 'heap used should be positive')

    const memUsage = observations.find(o => o.name === 'process.memory.usage')
    assert.ok(memUsage, 'process.memory.usage should be observed')
    assert.ok(memUsage.value > 0, 'RSS should be positive')
  })

  it('should include v8js.heap.space.name attribute on heap space metrics', () => {
    otlpMetrics.start({ runtimeMetrics: {} })

    const observations = []
    const observer = {
      observe (instrument, value, attrs) {
        observations.push({ name: instrument.name, value, attrs })
      },
    }

    observeCallbacks[0](observer)

    const spaceMetrics = observations.filter(o => o.name === 'v8js.memory.heap.space.available_size')
    assert.ok(spaceMetrics.length > 0, 'should have heap space metrics')
    assert.ok(spaceMetrics.some(m => m.attrs?.['v8js.heap.space.name'] === 'new_space'), 'should have new_space')
    assert.ok(spaceMetrics.some(m => m.attrs?.['v8js.heap.space.name'] === 'old_space'), 'should have old_space')
  })

  it('should include process.cpu.state attribute on CPU metrics', () => {
    otlpMetrics.start({ runtimeMetrics: {} })

    const observations = []
    const observer = {
      observe (instrument, value, attrs) {
        observations.push({ name: instrument.name, value, attrs })
      },
    }

    // Need two callback invocations for CPU delta (first sets baseline)
    observeCallbacks[0](observer)
    observations.length = 0
    observeCallbacks[0](observer)

    const cpuMetrics = observations.filter(o => o.name === 'process.cpu.utilization')
    assert.ok(cpuMetrics.length === 2, 'should have user and system CPU metrics')
    assert.ok(cpuMetrics.some(m => m.attrs?.['process.cpu.state'] === 'user'), 'should have cpu.state=user')
    assert.ok(cpuMetrics.some(m => m.attrs?.['process.cpu.state'] === 'system'), 'should have cpu.state=system')
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
    assert.equal(observeCallbacks.length, 1)

    otlpMetrics.stop()
    // After stop, internal state should be cleared
    otlpMetrics.start({ runtimeMetrics: {} })
    // Should be able to start again without issues
    assert.equal(observeCallbacks.length, 2)
  })
})
