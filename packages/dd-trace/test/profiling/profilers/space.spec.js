'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')
const { AgentExporter } = require('../../../src/profiling/exporters/agent')
const { FileExporter } = require('../../../src/profiling/exporters/file')

// Test adapter: the space profiler reads the canonical DD_PROFILING_* names (allocation and OOM
// monitoring included) straight off the tracer config; only tags and exporters are passed through.
// Map the legacy flat option names onto a config-shaped object.
function makeSpace (Cls, {
  allocationProfilingEnabled = false,
  heapSamplingInterval = 512 * 1024,
  oomMonitoringEnabled = false,
  heapLimitExtensionSize = 0,
  maxHeapExtensionCount = 0,
  exportStrategies = [],
  tags = {},
  exporters = [],
} = {}) {
  return new Cls({
    DD_PROFILING_HEAP_SAMPLING_INTERVAL: heapSamplingInterval,
    DD_PROFILING_ALLOCATION_ENABLED: allocationProfilingEnabled,
    DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED: oomMonitoringEnabled,
    DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE: heapLimitExtensionSize,
    DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT: maxHeapExtensionCount,
    DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES: exportStrategies,
  }, { tags, exporters })
}

const exporterCliPath = path.join(__dirname, '../../../src/profiling', 'exporter_cli.js')

describe('profilers/native/space', () => {
  let NativeSpaceProfiler
  let pprof
  let profile0

  beforeEach(() => {
    profile0 = {
      encodeAsync: sinon.stub().returns(Promise.resolve('encoded')),
    }
    pprof = {
      heap: {
        start: sinon.stub(),
        stop: sinon.stub(),
        profile: sinon.stub().returns(profile0),
        monitorOutOfMemory: sinon.stub(),
        CallbackMode: { Async: 1 },
      },
    }

    NativeSpaceProfiler = proxyquire('../../../src/profiling/profilers/space', {
      '@datadog/pprof': pprof,
    })
  })

  it('should start the internal space profiler', () => {
    const profiler = makeSpace(NativeSpaceProfiler, { allocationProfilingEnabled: false })

    profiler.start()

    sinon.assert.calledOnce(pprof.heap.start)
  })

  it('should use the provided configuration options', () => {
    const heapSamplingInterval = 1024
    const profiler = makeSpace(NativeSpaceProfiler, { heapSamplingInterval, allocationProfilingEnabled: false })

    profiler.start()

    sinon.assert.calledOnce(pprof.heap.start)
    sinon.assert.calledWith(pprof.heap.start, heapSamplingInterval, 64, false)
  })

  it('should enable allocation profiling when configured', () => {
    const profiler = makeSpace(NativeSpaceProfiler, { allocationProfilingEnabled: true })

    profiler.start()

    sinon.assert.calledOnceWithExactly(pprof.heap.start, 512 * 1024, 64, true)
  })

  it('should stop the internal space profiler', () => {
    const profiler = makeSpace(NativeSpaceProfiler)

    assert.strictEqual(profiler.isStarted(), false)
    profiler.start()
    assert.strictEqual(profiler.isStarted(), true)
    profiler.stop()
    assert.strictEqual(profiler.isStarted(), false)

    sinon.assert.calledOnce(pprof.heap.stop)
  })

  it('should provide info', () => {
    const profiler = makeSpace(NativeSpaceProfiler)

    const info = profiler.getInfo()
    assert.strictEqual(Object.keys(info).length, 0)
  })

  it('should collect profiles from the pprof space profiler', () => {
    const profiler = makeSpace(NativeSpaceProfiler)

    profiler.start()

    pprof.heap.profile.returns('profile')

    const profile = profiler.profile(true)
    assert.strictEqual(profiler.isStarted(), true)

    assert.strictEqual(profile, 'profile')
  })

  it('should collect profiles from the pprof space profiler and stop profiler if not restarted', () => {
    const profiler = makeSpace(NativeSpaceProfiler)

    profiler.start()

    pprof.heap.profile.returns('profile')

    const profile = profiler.profile(false)
    assert.strictEqual(profiler.isStarted(), false)

    assert.strictEqual(profile, 'profile')
  })

  it('should encode profiles using their encodeAsync method', () => {
    const profiler = makeSpace(NativeSpaceProfiler)

    profiler.start()
    const profile = profiler.profile(true)
    profiler.encode(profile)

    sinon.assert.calledOnce(profile0.encodeAsync)
  })

  it('should use mapper if given', () => {
    const profiler = makeSpace(NativeSpaceProfiler)

    const mapper = {}

    profiler.start({ mapper })
    profiler.profile(true)

    sinon.assert.calledWith(pprof.heap.profile, undefined, mapper)
  })

  it('should not monitor out of memory when OOM monitoring is disabled', () => {
    const profiler = makeSpace(NativeSpaceProfiler, { oomMonitoringEnabled: false })

    profiler.start()

    sinon.assert.notCalled(pprof.heap.monitorOutOfMemory)
  })

  it('should monitor out of memory with the agent export command for the process strategy', () => {
    const url = new URL('http://127.0.0.1:8126/')
    const profiler = makeSpace(NativeSpaceProfiler, {
      oomMonitoringEnabled: true,
      heapLimitExtensionSize: 1_000_000,
      maxHeapExtensionCount: 2,
      exportStrategies: ['process', 'async'],
      tags: { service: 'test-service' },
      exporters: [new AgentExporter({ url, DD_PROFILING_UPLOAD_TIMEOUT: 60_000 })],
    })

    profiler.start()

    sinon.assert.calledOnce(pprof.heap.monitorOutOfMemory)
    const [heapLimitExtensionSize, maxHeapExtensionCount, logsEnabled, exportCommand, , callbackMode] =
      pprof.heap.monitorOutOfMemory.firstCall.args
    assert.strictEqual(heapLimitExtensionSize, 1_000_000)
    assert.strictEqual(maxHeapExtensionCount, 2)
    assert.strictEqual(logsEnabled, false)
    assert.deepStrictEqual(exportCommand, [
      process.execPath,
      exporterCliPath,
      'http://127.0.0.1:8126/',
      'service:test-service,snapshot:on_oom',
      'space',
    ])
    assert.strictEqual(callbackMode, pprof.heap.CallbackMode.Async)
  })

  it('should target the file URL in the export command for the file exporter', () => {
    const profiler = makeSpace(NativeSpaceProfiler, {
      oomMonitoringEnabled: true,
      exportStrategies: ['process'],
      exporters: [new FileExporter({ DD_PROFILING_PPROF_PREFIX: '/tmp/profile-' })],
    })

    profiler.start()

    const exportCommand = pprof.heap.monitorOutOfMemory.firstCall.args[3]
    assert.deepStrictEqual(exportCommand, [
      process.execPath,
      exporterCliPath,
      'file:///tmp/profile-',
      'snapshot:on_oom',
      'space',
    ])
  })

  it('should omit the export command for non-process strategies', () => {
    const profiler = makeSpace(NativeSpaceProfiler, {
      oomMonitoringEnabled: true,
      exportStrategies: ['logs'],
      exporters: [],
    })

    profiler.start()

    const [, , logsEnabled, exportCommand] = pprof.heap.monitorOutOfMemory.firstCall.args
    assert.strictEqual(logsEnabled, true)
    assert.deepStrictEqual(exportCommand, [])
  })
})
