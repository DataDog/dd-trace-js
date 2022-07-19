'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')
const sinon = require('sinon')
const tracer = require('../../..')

describe('profilers/native/cpu', () => {
  let NativeCpuProfiler
  let CpuProfiler
  let pprof
  let start
  let stop
  let profile
  let setter
  let getter

  beforeEach(() => {
    CpuProfiler = sinon.stub()
    start = sinon.stub()
    stop = sinon.stub()
    profile = sinon.stub().returns('profile')
    setter = sinon.stub()
    getter = sinon.stub()

    CpuProfiler.prototype.start = start
    CpuProfiler.prototype.stop = stop
    CpuProfiler.prototype.profile = profile
    Object.defineProperty(CpuProfiler.prototype, 'labels', {
      set: setter,
      get: getter
    })

    pprof = {
      encode: sinon.stub().returns(Promise.resolve()),
      CpuProfiler
    }

    NativeCpuProfiler = proxyquire('../../../src/profiling/profilers/cpu', {
      '@datadog/pprof': pprof
    })
  })

  it('should start the internal time profiler', () => {
    const profiler = new NativeCpuProfiler()

    expect(profiler._started).to.be.false
    profiler.start()
    expect(profiler._started).to.be.true

    sinon.assert.calledOnce(start)
    sinon.assert.calledWith(start, 99)
  })

  it('should use given sample frequency', () => {
    const profiler = new NativeCpuProfiler({
      frequency: 123
    })

    profiler.start()

    sinon.assert.calledOnce(start)
    sinon.assert.calledWith(start, 123)
  })

  it('should not get profile when not started', () => {
    const profiler = new NativeCpuProfiler()

    profiler.profile()

    sinon.assert.notCalled(profile)
  })

  it('should get profile when started', () => {
    const profiler = new NativeCpuProfiler()

    profiler.start()
    profiler.profile()

    sinon.assert.calledOnce(profile)
  })

  it('should not stop when not started', () => {
    const profiler = new NativeCpuProfiler()

    profiler.stop()

    sinon.assert.notCalled(stop)
  })

  it('should stop when started', () => {
    const profiler = new NativeCpuProfiler()

    expect(profiler._started).to.be.false
    profiler.start()
    expect(profiler._started).to.be.true
    profiler.stop()
    expect(profiler._started).to.be.false

    sinon.assert.calledOnce(stop)
  })

  it('should encode profile', () => {
    const profiler = new NativeCpuProfiler()

    profiler.start()

    const profile = profiler.profile()

    profiler.encode(profile)

    sinon.assert.calledOnce(pprof.encode)
  })

  it('should track labels across async boundaries', () => {
    tracer.init()
    tracer.trace('foo.bar', {
      service: 'service',
      resource: 'resource',
      type: 'web'
    }, (span, cb) => {
      const profiler = new NativeCpuProfiler()
      profiler.start()

      // Should immediately have labels available
      const spanId = span.context().toSpanId()
      sinon.assert.calledWithMatch(setter, {
        'local root span id': spanId,
        'span id': spanId,
        'trace endpoint': 'resource'
      })

      setter.resetHistory()

      setImmediate(() => {
        // Should also have labels available asynchronously
        sinon.assert.calledWithMatch(setter, {
          'local root span id': spanId,
          'span id': spanId,
          'trace endpoint': 'resource'
        })
        cb()
      })
    })
  })
})
