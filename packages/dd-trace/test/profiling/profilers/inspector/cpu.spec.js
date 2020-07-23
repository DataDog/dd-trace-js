'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')

describe('profilers/inspector/cpu', () => {
  let InspectorCpuProfiler
  let profiler
  let mapper

  describe('with the inspector module enabled', () => {
    beforeEach(() => {
      InspectorCpuProfiler = require('../../../../src/profiling/profilers/inspector/cpu').InspectorCpuProfiler

      mapper = { getSource: callFrame => Promise.resolve(callFrame) }
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

  describe('with the inspector module disabled', () => {
    it('should throw when started', async () => {
      expect(() => {
        InspectorCpuProfiler = proxyquire('../../../../src/profiling/profilers/inspector/cpu', {
          inspector: null
        }).InspectorCpuProfiler

        profiler = new InspectorCpuProfiler()
      }).to.not.throw()

      expect(() => {
        profiler.start({ mapper })
      }).to.throw()
    })
  })
})
