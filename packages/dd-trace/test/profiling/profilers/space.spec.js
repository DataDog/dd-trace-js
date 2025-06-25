'use strict'

const t = require('tap')
require('../../setup/core')

const { expect } = require('chai')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

t.test('profilers/native/space', t => {
  let NativeSpaceProfiler
  let pprof
  let profile0

  t.beforeEach(() => {
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

  t.test('should start the internal space profiler', t => {
    const profiler = new NativeSpaceProfiler()

    profiler.start()

    sinon.assert.calledOnce(pprof.heap.start)
    t.end()
  })

  t.test('should use the provided configuration options', t => {
    const heapSamplingInterval = 1024
    const stackDepth = 10
    const profiler = new NativeSpaceProfiler({ heapSamplingInterval, stackDepth })

    profiler.start()

    sinon.assert.calledOnce(pprof.heap.start)
    sinon.assert.calledWith(pprof.heap.start, heapSamplingInterval, stackDepth)
    t.end()
  })

  t.test('should stop the internal space profiler', t => {
    const profiler = new NativeSpaceProfiler()

    expect(profiler.isStarted()).to.be.false
    profiler.start()
    expect(profiler.isStarted()).to.be.true
    profiler.stop()
    expect(profiler.isStarted()).to.be.false

    sinon.assert.calledOnce(pprof.heap.stop)
    t.end()
  })

  t.test('should collect profiles from the pprof space profiler', t => {
    const profiler = new NativeSpaceProfiler()

    profiler.start()

    pprof.heap.profile.returns('profile')

    const profile = profiler.profile(true)
    expect(profiler.isStarted()).to.be.true

    expect(profile).to.equal('profile')
    t.end()
  })

  t.test('should collect profiles from the pprof space profiler and stop profiler if not restarted', t => {
    const profiler = new NativeSpaceProfiler()

    profiler.start()

    pprof.heap.profile.returns('profile')

    const profile = profiler.profile(false)
    expect(profiler.isStarted()).to.be.false

    expect(profile).to.equal('profile')
    t.end()
  })

  t.test('should encode profiles using their encodeAsync method', t => {
    const profiler = new NativeSpaceProfiler()

    profiler.start()
    const profile = profiler.profile(true)
    profiler.encode(profile)

    sinon.assert.calledOnce(profile0.encodeAsync)
    t.end()
  })

  t.test('should use mapper if given', t => {
    const profiler = new NativeSpaceProfiler()

    const mapper = {}

    profiler.start({ mapper })
    profiler.profile(true)

    sinon.assert.calledWith(pprof.heap.profile, undefined, mapper)
    t.end()
  })
  t.end()
})
