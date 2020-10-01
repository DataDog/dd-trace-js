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

    it('should serialize profiles in the correct format', done => {
      profiler.start({ mapper })

      profiler.profile((err, profile) => {
        try {
          expect(err).to.be.null
          expect(profile).to.be.a.profile

          done()
        } catch (e) {
          done(e)
        }
      })
    })
  })

  describe('with the inspector module disabled', () => {
    it('should throw when started', () => {
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
