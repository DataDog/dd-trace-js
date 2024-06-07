'use strict'

require('../../setup/tap')

const { expect } = require('chai')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('profilers/native/wall', () => {
  let NativeWallProfiler
  let pprof

  beforeEach(() => {
    pprof = {
      encode: sinon.stub().returns(Promise.resolve()),
      time: {
        start: sinon.stub(),
        stop: sinon.stub().returns('profile'),
        v8ProfilerStuckEventLoopDetected: sinon.stub().returns(false),
        constants: {
          kSampleCount: 0
        }
      }
    }

    NativeWallProfiler = proxyquire('../../../src/profiling/profilers/wall', {
      '@datadog/pprof': pprof
    })
  })

  it('should start the internal time profiler', () => {
    const profiler = new NativeWallProfiler()

    // Verify start/stop profiler idle notifiers are created if not present.
    // These functions may not exist in worker threads.
    const start = process._startProfilerIdleNotifier
    const stop = process._stopProfilerIdleNotifier

    delete process._startProfilerIdleNotifier
    delete process._stopProfilerIdleNotifier

    profiler.start()

    expect(process._startProfilerIdleNotifier).to.be.a('function')
    expect(process._stopProfilerIdleNotifier).to.be.a('function')

    process._startProfilerIdleNotifier = start
    process._stopProfilerIdleNotifier = stop

    sinon.assert.calledOnce(pprof.time.start)
    sinon.assert.calledWith(pprof.time.start,
      {
        intervalMicros: 1e6 / 99,
        durationMillis: 60000,
        sourceMapper: undefined,
        withContexts: false,
        lineNumbers: false,
        workaroundV8Bug: false,
        collectCpuTime: false
      })
  })

  it('should use the provided configuration options', () => {
    const samplingInterval = 500
    const profiler = new NativeWallProfiler({ samplingInterval })

    profiler.start()
    profiler.stop()

    sinon.assert.calledWith(pprof.time.start,
      {
        intervalMicros: 500,
        durationMillis: 60000,
        sourceMapper: undefined,
        withContexts: false,
        lineNumbers: false,
        workaroundV8Bug: false,
        collectCpuTime: false
      })
  })

  it('should not stop when not started', () => {
    const profiler = new NativeWallProfiler()

    profiler.stop()

    sinon.assert.notCalled(pprof.time.stop)
  })

  it('should stop the internal time profiler', () => {
    const profiler = new NativeWallProfiler()

    profiler.start()
    profiler.stop()

    sinon.assert.calledOnce(pprof.time.stop)
  })

  it('should stop the internal time profiler only once', () => {
    const profiler = new NativeWallProfiler()

    profiler.start()
    profiler.stop()
    profiler.stop()

    sinon.assert.calledOnce(pprof.time.stop)
  })

  it('should collect profiles from the internal time profiler', () => {
    const profiler = new NativeWallProfiler()

    expect(profiler.isStarted()).to.be.false
    profiler.start()
    expect(profiler.isStarted()).to.be.true

    const profile = profiler.profile(true)

    expect(profile).to.equal('profile')

    sinon.assert.calledOnce(pprof.time.stop)
    sinon.assert.calledOnce(pprof.time.start)
    expect(profiler.isStarted()).to.be.true
    profiler.stop()
    expect(profiler.isStarted()).to.be.false
    sinon.assert.calledTwice(pprof.time.stop)
  })

  it('should collect profiles from the internal time profiler and stop profiler if not restarted', () => {
    const profiler = new NativeWallProfiler()

    profiler.start()

    const profile = profiler.profile(false)

    expect(profile).to.equal('profile')

    sinon.assert.calledOnce(pprof.time.stop)
    sinon.assert.calledOnce(pprof.time.start)
    expect(profiler.isStarted()).to.be.false
    profiler.stop()
    sinon.assert.calledOnce(pprof.time.stop)
  })

  it('should encode profiles from the pprof time profiler', () => {
    const profiler = new NativeWallProfiler()

    profiler.start()

    const profile = profiler.profile(true)

    profiler.encode(profile)

    profiler.stop()

    sinon.assert.calledOnce(pprof.encode)
  })

  it('should use mapper if given', () => {
    const profiler = new NativeWallProfiler()

    const mapper = {}

    profiler.start({ mapper })
    profiler.stop()

    sinon.assert.calledWith(pprof.time.start,
      {
        intervalMicros: 1e6 / 99,
        durationMillis: 60000,
        sourceMapper: mapper,
        withContexts: false,
        lineNumbers: false,
        workaroundV8Bug: false,
        collectCpuTime: false
      })
  })
})
