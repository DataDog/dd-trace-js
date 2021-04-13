'use strict'

const proxyquire = require('proxyquire')
const sinon = require('sinon')
const semver = require('semver')

if (!semver.satisfies(process.version, '>=10.12')) {
  describe = describe.skip // eslint-disable-line no-global-assign
}

describe('profilers/native/cpu', () => {
  let NativeCpuProfiler
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

    NativeCpuProfiler = proxyquire('../../../src/profiling/profilers/cpu', {
      'pprof': pprof
    })
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
    profiler.profile(() => {})

    sinon.assert.calledOnce(pprof.encode)

    sinon.assert.calledOnce(stop)
    sinon.assert.calledTwice(pprof.time.start)
  })
})
