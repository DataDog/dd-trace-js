'use strict'

const { expect } = require('chai')

describe('profilers/inspector/cpu', () => {
  let InspectorCpuProfiler
  let profiler
  let mapper

  beforeEach(() => {
    InspectorCpuProfiler = require('../../../../src/profiling/profilers/inspector/cpu').InspectorCpuProfiler

    mapper = { map: callFrame => Promise.resolve(callFrame) }
    profiler = new InspectorCpuProfiler()
  })

  afterEach(() => {
    profiler.stop()
  })

  it('should serialize profiles in the correct format', async () => {
    profiler.start({ mapper })

    const profile = await profiler.profile()

    expect(profile).to.be.a.profile
  })
})
