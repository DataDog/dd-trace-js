'use strict'

const { expect } = require('chai')
const semver = require('semver')
const proxyquire = require('proxyquire')

if (!semver.satisfies(process.version, '>=10.12')) {
  describe = describe.skip // eslint-disable-line no-global-assign
}

describe('profilers/inspector/heap', () => {
  let InspectorHeapProfiler
  let profiler
  let mapper

  describe('with the inspector module enabled', () => {
    beforeEach(() => {
      InspectorHeapProfiler = require('../../../../src/profiling/profilers/inspector/heap').InspectorHeapProfiler

      mapper = { getSource: callFrame => Promise.resolve(callFrame) }
      profiler = new InspectorHeapProfiler()
    })

    afterEach(() => {
      profiler.stop()
    })

    it('should serialize profiles in the correct format', done => {
      profiler.start({ mapper })

      const obj = {}

      // heap profiler doesn't start synchronously
      setImmediate(async () => {
        // force at least the minimum sampling interval
        for (let i = 0; i < 1024 * 1024; i++) {
          obj[`${i}`] = i * 2
        }

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
  })

  describe('with the inspector module disabled', () => {
    it('should throw when started', async () => {
      expect(() => {
        InspectorHeapProfiler = proxyquire('../../../../src/profiling/profilers/inspector/heap', {
          inspector: null
        }).InspectorHeapProfiler

        profiler = new InspectorHeapProfiler()
      }).to.not.throw()

      expect(() => {
        profiler.start({ mapper })
      }).to.throw()
    })
  })
})
