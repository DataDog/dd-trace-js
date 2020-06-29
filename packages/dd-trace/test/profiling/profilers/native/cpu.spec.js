'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('profilers/native/cpu', () => {
  let NativeCpuProfiler
  let pprof
  let stop
  let maybeRequire

  beforeEach(() => {
    stop = sinon.stub().returns('profile')
    pprof = {
      time: {
        start: sinon.stub().returns(stop)
      }
    }
    maybeRequire = sinon.stub()
    maybeRequire.withArgs('pprof').returns(pprof)

    NativeCpuProfiler = proxyquire('../../../../src/profiling/profilers/native/cpu', {
      '../../util': { maybeRequire }
    }).NativeCpuProfiler
  })

  it('should start the internal time profiler', () => {
    const profiler = new NativeCpuProfiler()

    profiler.start()

    sinon.assert.calledOnce(pprof.time.start)
    sinon.assert.calledWith(pprof.time.start, 10000)
  })

  it('should use the provided configuration options', () => {
    const samplingInterval = 500
    const profiler = new NativeCpuProfiler({ samplingInterval })

    profiler.start()

    sinon.assert.calledWith(pprof.time.start, samplingInterval)
  })

  it('should stop the internal time profiler', () => {
    const profiler = new NativeCpuProfiler()

    profiler.start()
    profiler.stop()

    sinon.assert.calledOnce(stop)
  })

  it('should collect profiles from the internal time profiler', () => {
    const profiler = new NativeCpuProfiler()

    profiler.start()

    const profile = profiler.profile()

    expect(profile).to.equal('profile')

    sinon.assert.calledOnce(stop)
    sinon.assert.calledTwice(pprof.time.start)
  })
})
