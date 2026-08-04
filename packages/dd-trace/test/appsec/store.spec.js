'use strict'

const assert = require('node:assert/strict')
const { setTimeout: wait } = require('node:timers/promises')

const { describe, it } = require('mocha')

require('../setup/core')
const { storage } = require('../../../datadog-core')
const DatadogTracer = require('../../src/tracer')
const web = require('../../src/plugins/util/web')
const { getConfigFresh } = require('../helpers/config')
const { getActiveRequest, getRequest, withRequest } = require('../../src/appsec/store')

const gc = global.gc

describe('AppSec store', () => {
  describe('withRequest', () => {
    it('should preserve weak request access through nested span stores', () => {
      const tracer = new DatadogTracer(getConfigFresh({
        enabled: true,
      }))
      const req = {}
      const res = { req }

      web.patch(req).res = res
      const store = withRequest(undefined, req)

      storage('legacy').enterWith(store)

      tracer.trace('root', {}, rootSpan => {
        const rootStore = storage('legacy').getStore()
        assert.strictEqual(getRequest(rootStore), req)

        tracer.trace('child', {}, childSpan => {
          const childStore = storage('legacy').getStore()

          assert.notStrictEqual(childStore, rootStore)
          assert.strictEqual(getRequest(childStore), req)
          assert.strictEqual(childStore.span, childSpan)
        })

        assert.strictEqual(storage('legacy').getStore().span, rootSpan)
      })
    })

    it('should not expose req or res as own enumerable properties', () => {
      const req = {}
      const res = { req }

      web.patch(req).res = res
      const store = withRequest(undefined, req)

      assert.strictEqual(getRequest(store), req)
      assert.strictEqual(Object.hasOwn(store, 'req'), false)
      assert.strictEqual(Object.hasOwn(store, 'res'), false)
    })
  })

  describe('getActiveRequest', () => {
    it('should resolve the request from the current legacy store', () => {
      const req = {}
      web.patch(req)

      storage('legacy').enterWith(withRequest(undefined, req))

      assert.strictEqual(getActiveRequest(), req)
    })

    it('should return undefined when no request is attached', () => {
      storage('legacy').enterWith({})

      assert.strictEqual(getActiveRequest(), undefined)
    })

    it('should allow the request to be collected even if a cloned child store remains alive', async function () {
      if (typeof gc !== 'function') this.skip()

      this.timeout(10000)

      const tracer = new DatadogTracer(getConfigFresh({
        enabled: true,
      }))
      let childStore
      let requestWasCollected = false
      const finalizationRegistry = new FinalizationRegistry(() => {
        requestWasCollected = true
      })

      ;(() => {
        const req = {}
        const res = { req }
        finalizationRegistry.register(req, 'request')
        web.patch(req).res = res

        storage('legacy').enterWith(withRequest(undefined, req))

        tracer.trace('root', {}, () => {
          tracer.trace('child', {}, () => {
            childStore = storage('legacy').getStore()
            assert.strictEqual(getRequest(childStore), req)
          })
        })
      })()

      // requestWasCollected is updated from the FinalizationRegistry callback.
      // eslint-disable-next-line no-unmodified-loop-condition
      for (let i = 0; i < 5 && !requestWasCollected; i++) {
        gc()
        await wait(100)
      }

      assert.strictEqual(requestWasCollected, true)
      assert.strictEqual(getRequest(childStore), undefined)
    })
  })
})
