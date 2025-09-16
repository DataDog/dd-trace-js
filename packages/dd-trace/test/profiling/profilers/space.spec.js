'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')

describe('profilers/native/space', () => {
  let NativeSpaceProfiler
  let pprof
  let profile0

  beforeEach(() => {
    profile0 = {
      encodeAsync: sinon.stub().returns(Promise.resolve('encoded'))
    }
    pprof = {
      heap: {
        start: sinon.stub(),
        stop: sinon.stub(),
        profile: sinon.stub().returns(profile0)
      }
    }

    NativeSpaceProfiler = proxyquire('../../../src/profiling/profilers/space', {
      '@datadog/pprof': pprof
    })
  })

  it('should start the internal space profiler', () => {
    const profiler = new NativeSpaceProfiler()

    profiler.start()

    sinon.assert.calledOnce(pprof.heap.start)
  })

  it('should use the provided configuration options', () => {
    const heapSamplingInterval = 1024
    const stackDepth = 10
    const profiler = new NativeSpaceProfiler({ heapSamplingInterval, stackDepth })

    profiler.start()

    sinon.assert.calledOnce(pprof.heap.start)
    sinon.assert.calledWith(pprof.heap.start, heapSamplingInterval, stackDepth)
  })

  it('should stop the internal space profiler', () => {
    const profiler = new NativeSpaceProfiler()

    expect(profiler.isStarted()).to.be.false
    profiler.start()
    expect(profiler.isStarted()).to.be.true
    profiler.stop()
    expect(profiler.isStarted()).to.be.false

    sinon.assert.calledOnce(pprof.heap.stop)
  })

  it('should collect profiles from the pprof space profiler', () => {
    const profiler = new NativeSpaceProfiler()

    profiler.start()

    pprof.heap.profile.returns('profile')

    const profile = profiler.profile(true)
    expect(profiler.isStarted()).to.be.true

    expect(profile).to.equal('profile')
  })

  it('should collect profiles from the pprof space profiler and stop profiler if not restarted', () => {
    const profiler = new NativeSpaceProfiler()

    profiler.start()

    pprof.heap.profile.returns('profile')

    const profile = profiler.profile(false)
    expect(profiler.isStarted()).to.be.false

    expect(profile).to.equal('profile')
  })

  it('should encode profiles using their encodeAsync method', () => {
    const profiler = new NativeSpaceProfiler()

    profiler.start()
    const profile = profiler.profile(true)
    profiler.encode(profile)

    sinon.assert.calledOnce(profile0.encodeAsync)
  })

  it('should use mapper if given', () => {
    const profiler = new NativeSpaceProfiler()

    const mapper = {}

    profiler.start({ mapper })
    profiler.profile(true)

    sinon.assert.calledWith(pprof.heap.profile, undefined, mapper)
  })
})
