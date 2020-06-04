'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('profilers/native/heap', () => {
  let NativeHeapProfiler
  let pprof
  let maybeRequire

  beforeEach(() => {
    pprof = {
      heap: {
        start: sinon.stub(),
        stop: sinon.stub(),
        profile: sinon.stub()
      }
    }
    maybeRequire = sinon.stub()
    maybeRequire.withArgs('pprof').returns(pprof)

    NativeHeapProfiler = proxyquire('../../../../src/profiling/profilers/native/heap', {
      '../../util': { maybeRequire }
    }).NativeHeapProfiler
  })

  it('should start the internal heap profiler', () => {
    const profiler = new NativeHeapProfiler()

    profiler.start()

    sinon.assert.calledOnce(pprof.heap.start)
  })

  it('should use the provided configuration options', () => {
    const samplingInterval = 1024
    const stackDepth = 10
    const profiler = new NativeHeapProfiler({ samplingInterval, stackDepth })

    profiler.start()

    sinon.assert.calledOnce(pprof.heap.start)
    sinon.assert.calledWith(pprof.heap.start, samplingInterval, stackDepth)
  })

  it('should stop the internal heap profiler', () => {
    const profiler = new NativeHeapProfiler()

    profiler.start()
    profiler.stop()

    sinon.assert.calledOnce(pprof.heap.stop)
  })

  it('should collect profiles from the internal heap profiler', () => {
    const profiler = new NativeHeapProfiler()

    profiler.start()

    pprof.heap.profile.returns('profile')

    const profile = profiler.profile()

    expect(profile).to.equal('profile')
  })
})
