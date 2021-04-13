'use strict'

const proxyquire = require('proxyquire')
const sinon = require('sinon')
const semver = require('semver')

if (!semver.satisfies(process.version, '>=10.12')) {
  describe = describe.skip // eslint-disable-line no-global-assign
}

describe('profilers/native/heap', () => {
  let NativeHeapProfiler
  let pprof

  beforeEach(() => {
    pprof = {
      encode: sinon.stub().returns(Promise.resolve()),
      heap: {
        start: sinon.stub(),
        stop: sinon.stub(),
        profile: sinon.stub()
      }
    }

    NativeHeapProfiler = proxyquire('../../../src/profiling/profilers/heap', {
      'pprof': pprof
    })
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
    profiler.profile(() => {})

    sinon.assert.calledOnce(pprof.encode)
  })
})
