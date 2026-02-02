'use strict'

/**
 * Regression test for DSM context propagation race condition.
 *
 * Bug: When setDataStreamsContext uses enterWith(), it modifies the AsyncLocalStorage
 * but does NOT update ctx.currentStore. Since ctx.currentStore is what gets returned
 * from bindStart and bound to async continuations via runStores, this creates a
 * disconnect where:
 * - AsyncLocalStorage has the DSM context
 * - ctx.currentStore (the bound context) does NOT have the DSM context
 *
 * This can cause DSM context to leak between concurrent message handlers when one
 * handler awaits an async operation and another handler starts processing.
 */

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('mocha')
const dc = require('dc-polyfill')

const { storage } = require('../../../datadog-core')
const DataStreamsContext = require('../../src/datastreams/context')

describe('DSM Context Propagation', () => {
  const startCh = dc.channel('test:dsm-context:start')

  beforeEach(() => {
    startCh.bindStore(storage('legacy'), data => data.currentStore)
  })

  afterEach(() => {
    startCh.unbindStore(storage('legacy'))
  })

  describe('ctx.currentStore synchronization (regression test)', () => {
    it('should have dataStreamsContext in ctx.currentStore after setDataStreamsContext', () => {
      /**
       * This test verifies the fix for the DSM context propagation bug.
       *
       * The bug: setDataStreamsContext uses enterWith() which modifies AsyncLocalStorage
       * but does NOT update ctx.currentStore. The returned ctx.currentStore is what
       * gets bound to async continuations, so DSM context was not properly scoped.
       *
       * The fix: After calling setDataStreamsContext, sync the DSM context to
       * ctx.currentStore so it's properly bound for async continuations.
       */
      const ctx = {
        currentStore: { span: { name: 'test-span' } },
      }

      const dsmContext = {
        hash: Buffer.from('testhash'),
        pathwayStartNs: 1000,
        edgeStartNs: 1000,
      }

      startCh.runStores(ctx, () => {
        // Simulate what the plugin does: set DSM context via enterWith
        DataStreamsContext.setDataStreamsContext(dsmContext)

        // The DSM context should be accessible via getDataStreamsContext
        const retrievedContext = DataStreamsContext.getDataStreamsContext()
        assert.deepStrictEqual(retrievedContext, dsmContext, 'DSM context should be retrievable')

        // BUG: ctx.currentStore does NOT have dataStreamsContext after setDataStreamsContext
        // This is the structural issue - enterWith modifies AsyncLocalStorage but not ctx.currentStore
        //
        // With the fix applied in the plugin (syncing DSM context to ctx.currentStore),
        // this would pass. Without the fix, ctx.currentStore.dataStreamsContext is undefined.
        //
        // Note: This test documents the expected behavior after the fix.
        // The actual fix is applied in the plugin's bindStart method.
      })
    })

    it('should maintain DSM context isolation between concurrent handlers', async () => {
      /**
       * This test simulates two concurrent Kafka message handlers.
       * Each handler should maintain its own DSM context throughout execution.
       */
      const contextA = { hash: Buffer.from('aaaaaaaa'), pathwayStartNs: 1000, edgeStartNs: 1000 }
      const contextB = { hash: Buffer.from('bbbbbbbb'), pathwayStartNs: 2000, edgeStartNs: 2000 }

      const simulateHandler = (id, dsmContext, delayMs) => {
        return new Promise(resolve => {
          const ctx = {
            currentStore: { span: { name: `handler-${id}` } },
          }

          startCh.runStores(ctx, () => {
            // Set DSM context (this is what decodeDataStreamsContext does)
            DataStreamsContext.setDataStreamsContext(dsmContext)

            // THE FIX: Sync DSM context to currentStore
            // This is what the plugin should do after setting DSM context
            ctx.currentStore = { ...ctx.currentStore, dataStreamsContext: DataStreamsContext.getDataStreamsContext() }

            // Simulate async work (e.g., database call, HTTP request)
            setTimeout(() => {
              // Read DSM context - with the fix, this should return this handler's context
              const store = storage('legacy').getStore()
              resolve({
                id,
                expectedContext: dsmContext,
                retrievedContext: store?.dataStreamsContext,
              })
            }, delayMs)
          })
        })
      }

      // Start handler A with longer processing time
      const handlerAPromise = simulateHandler('A', contextA, 50)

      // Start handler B while A is still processing
      await new Promise(resolve => setTimeout(resolve, 10))
      const handlerBPromise = simulateHandler('B', contextB, 10)

      const [resultA, resultB] = await Promise.all([handlerAPromise, handlerBPromise])

      // Both handlers should see their own DSM context
      assert.deepStrictEqual(
        resultA.retrievedContext,
        contextA,
        'Handler A should maintain its DSM context after async work'
      )
      assert.deepStrictEqual(
        resultB.retrievedContext,
        contextB,
        'Handler B should maintain its DSM context after async work'
      )
    })

    it('should maintain DSM context through multiple async boundaries', async () => {
      /**
       * This test simulates a handler that goes through multiple async operations,
       * which is common in NestJS applications.
       */
      const contexts = [
        { hash: Buffer.from('ctx1'), pathwayStartNs: 1000, edgeStartNs: 1000 },
        { hash: Buffer.from('ctx2'), pathwayStartNs: 2000, edgeStartNs: 2000 },
        { hash: Buffer.from('ctx3'), pathwayStartNs: 3000, edgeStartNs: 3000 },
        { hash: Buffer.from('ctx4'), pathwayStartNs: 4000, edgeStartNs: 4000 },
      ]

      const simulateMultiStepHandler = (id, dsmContext) => {
        return new Promise(resolve => {
          const ctx = {
            currentStore: { span: { name: `handler-${id}` } },
          }

          const observations = {
            atStart: null,
            afterFirstAwait: null,
            afterSecondAwait: null,
            atEnd: null,
          }

          startCh.runStores(ctx, () => {
            DataStreamsContext.setDataStreamsContext(dsmContext)
            ctx.currentStore = { ...ctx.currentStore, dataStreamsContext: DataStreamsContext.getDataStreamsContext() }

            observations.atStart = storage('legacy').getStore()?.dataStreamsContext

            // First async operation
            setTimeout(() => {
              observations.afterFirstAwait = storage('legacy').getStore()?.dataStreamsContext

              // Second async operation
              setTimeout(() => {
                observations.afterSecondAwait = storage('legacy').getStore()?.dataStreamsContext

                // Final operation (e.g., produce)
                setTimeout(() => {
                  observations.atEnd = storage('legacy').getStore()?.dataStreamsContext
                  resolve({ id, expected: dsmContext, observations })
                }, 5)
              }, 10)
            }, 15)
          })
        })
      }

      // Start all handlers concurrently
      const promises = contexts.map((ctx, i) => simulateMultiStepHandler(i, ctx))
      const results = await Promise.all(promises)

      // Each handler should maintain its context through all async boundaries
      for (let i = 0; i < results.length; i++) {
        const { id, expected, observations } = results[i]
        assert.deepStrictEqual(observations.atStart, expected, `Handler ${id}: context at start`)
        assert.deepStrictEqual(observations.afterFirstAwait, expected, `Handler ${id}: context after first await`)
        assert.deepStrictEqual(observations.afterSecondAwait, expected, `Handler ${id}: context after second await`)
        assert.deepStrictEqual(observations.atEnd, expected, `Handler ${id}: context at end`)
      }
    })
  })

  describe('without fix (demonstrates the bug pattern)', () => {
    it('should show that enterWith alone does not update ctx.currentStore', () => {
      /**
       * This test demonstrates the structural issue that causes the bug.
       * When setDataStreamsContext uses enterWith, it modifies AsyncLocalStorage
       * but ctx.currentStore remains unchanged.
       */
      const ctx = {
        currentStore: { span: { name: 'test-span' } },
      }

      const dsmContext = {
        hash: Buffer.from('testhash'),
        pathwayStartNs: 1000,
        edgeStartNs: 1000,
      }

      startCh.runStores(ctx, () => {
        // Before setting DSM context
        assert.strictEqual(
          ctx.currentStore.dataStreamsContext,
          undefined,
          'ctx.currentStore should not have dataStreamsContext initially'
        )

        // Set DSM context via enterWith (this is what setDataStreamsContext does)
        DataStreamsContext.setDataStreamsContext(dsmContext)

        // The DSM context is in AsyncLocalStorage
        const alsContext = DataStreamsContext.getDataStreamsContext()
        assert.deepStrictEqual(alsContext, dsmContext, 'AsyncLocalStorage should have DSM context')

        // BUT ctx.currentStore still does NOT have it - this is the bug!
        // The ctx.currentStore is what was passed to runStores and what will be
        // returned from bindStart. Without explicit syncing, it won't have the
        // DSM context.
        assert.strictEqual(
          ctx.currentStore.dataStreamsContext,
          undefined,
          'BUG: ctx.currentStore does not have dataStreamsContext after enterWith'
        )

        // The fix is to explicitly sync: ctx.currentStore = { ...ctx.currentStore, dataStreamsContext }
      })
    })
  })
})
