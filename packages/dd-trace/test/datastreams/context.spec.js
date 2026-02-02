'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')

const { storage } = require('../../../datadog-core')
const {
  getDataStreamsContext,
  setDataStreamsContext,
  syncToStore,
} = require('../../src/datastreams/context')

describe('DSM Context', () => {
  let originalStore

  beforeEach(() => {
    originalStore = storage('legacy').getStore()
  })

  afterEach(() => {
    storage('legacy').enterWith(originalStore)
  })

  describe('syncToStore', () => {
    it('should sync DSM context from AsyncLocalStorage to ctx.currentStore', () => {
      const dsmContext = {
        hash: Buffer.from('testhash'),
        pathwayStartNs: 1000,
        edgeStartNs: 2000,
      }

      // Set DSM context via enterWith (simulating what setDataStreamsContext does)
      storage('legacy').enterWith({ dataStreamsContext: dsmContext })

      // ctx.currentStore doesn't have DSM context yet
      const ctx = { currentStore: { span: { name: 'test-span' } } }

      // syncToStore should copy DSM context to ctx.currentStore
      syncToStore(ctx)

      assert.deepStrictEqual(ctx.currentStore.dataStreamsContext, dsmContext)
      assert.strictEqual(ctx.currentStore.span.name, 'test-span')
    })

    it('should not modify ctx.currentStore if no DSM context exists', () => {
      storage('legacy').enterWith({})

      const ctx = { currentStore: { span: { name: 'test-span' } } }
      syncToStore(ctx)

      assert.strictEqual(ctx.currentStore.dataStreamsContext, undefined)
      assert.strictEqual(ctx.currentStore.span.name, 'test-span')
    })

    it('should handle missing ctx.currentStore gracefully', () => {
      const dsmContext = { hash: Buffer.from('test') }
      storage('legacy').enterWith({ dataStreamsContext: dsmContext })

      const ctx = {}
      const result = syncToStore(ctx)

      assert.strictEqual(result, undefined)
    })

    it('should handle null ctx gracefully', () => {
      const dsmContext = { hash: Buffer.from('test') }
      storage('legacy').enterWith({ dataStreamsContext: dsmContext })

      const result = syncToStore(null)

      assert.strictEqual(result, undefined)
    })

    it('should return the updated currentStore', () => {
      const dsmContext = { hash: Buffer.from('test') }
      storage('legacy').enterWith({ dataStreamsContext: dsmContext })

      const ctx = { currentStore: { span: {} } }
      const result = syncToStore(ctx)

      assert.strictEqual(result, ctx.currentStore)
      assert.deepStrictEqual(result.dataStreamsContext, dsmContext)
    })

    it('should work with setDataStreamsContext', () => {
      const dsmContext = {
        hash: Buffer.from('realcontext'),
        pathwayStartNs: 5000,
        edgeStartNs: 6000,
      }

      // Initialize store
      storage('legacy').enterWith({ span: {} })

      // This is what plugins do: set DSM context via the API
      setDataStreamsContext(dsmContext)

      // Verify it's in AsyncLocalStorage
      assert.deepStrictEqual(getDataStreamsContext(), dsmContext)

      // But ctx.currentStore (captured earlier) doesn't have it
      const ctx = { currentStore: { span: { name: 'handler-span' } } }

      // syncToStore fixes this
      syncToStore(ctx)

      assert.deepStrictEqual(ctx.currentStore.dataStreamsContext, dsmContext)
    })
  })
})
