'use strict'

require('../../setup/tap')

const { expect } = require('chai')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('profilers/native/wall', () => {
  let NativeWallProfiler
  let pprof
  let stop

  beforeEach(() => {
    stop = sinon.stub().returns('profile')
    pprof = {
      encode: sinon.stub().returns(Promise.resolve()),
      time: {
        start: sinon.stub().returns(stop)
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
    sinon.assert.calledWith(pprof.time.start, 1e6 / 99)
  })

  it('should use the provided configuration options', () => {
    const samplingInterval = 500
    const profiler = new NativeWallProfiler({ samplingInterval })

    profiler.start()

    sinon.assert.calledWith(pprof.time.start, samplingInterval)
  })

  it('should stop the internal time profiler', () => {
    const profiler = new NativeWallProfiler()

    profiler.start()
    profiler.stop()

    sinon.assert.calledOnce(stop)
  })

  it('should collect profiles from the internal time profiler', () => {
    const profiler = new NativeWallProfiler()

    profiler.start()

    const profile = profiler.profile()

    expect(profile).to.equal('profile')

    sinon.assert.calledOnce(stop)
    sinon.assert.calledOnce(pprof.time.start)
  })

  it('should encode profiles from the pprof time profiler', () => {
    const profiler = new NativeWallProfiler()

    profiler.start()

    const profile = profiler.profile()

    profiler.encode(profile)

    sinon.assert.calledOnce(pprof.encode)
  })

  it('should use mapper if given', () => {
    const profiler = new NativeWallProfiler()

    const mapper = {}

    profiler.start({ mapper })

    sinon.assert.calledWith(pprof.time.start, 1e6 / 99, null, mapper, false)
  })
})
