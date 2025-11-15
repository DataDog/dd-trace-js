'use strict'

const assert = require('node:assert')
const { setup } = require('./utils')

const DEFAULT_MAX_COLLECTION_SIZE = 100
const COLLECTION_SIZE_THRESHOLD = 500

describe('Dynamic Instrumentation', function () {
  describe('input messages', function () {
    describe('with snapshot under tight time budget', function () {
      context('1ms time budget', function () {
        // Force a very small time budget in ms to trigger partial snapshots
        const target = 1
        const t = setup({
          dependencies: ['fastify'],
          env: { DD_DYNAMIC_INSTRUMENTATION_CAPTURE_TIMEOUT_MS: String(target) }
        })

        it(
          'should include partial snapshot marked with notCapturedReason: timeout',
          // A tolerance of 10ms is used to avoid flakiness
          test({ t, maxPausedTime: target + 10, breakpointIndex: 0, maxReferenceDepth: 5 }, (locals) => {
            assert.strictEqual(
              containsTimeBudget(locals),
              true,
              'expected at least one field/element to be marked with notCapturedReason: "timeout"'
            )
          })
        )
      })

      context('default time budget', function () {
        const target = 10 // default time budget in ms
        const t = setup({ dependencies: ['fastify'] })

        it(
          'should timeout first, then disable subsequent snapshots and emit error diagnostics',
          async function () {
            const breakpoint = t.breakpoints[1]

            // Listen for the first snapshot payload (should contain notCapturedReason: "timeout")
            const firstPayloadReceived = new Promise((resolve) => {
              t.agent.once('debugger-input', ({ payload: [{ debugger: { snapshot: { captures } } }] }) => {
                const { locals } = captures.lines[breakpoint.line]
                resolve(locals)
              })
            })

            // Prepare to assert that an ERROR diagnostics event with exception details is emitted
            const errorDiagnosticsReceived = new Promise((/** @type {(value?: unknown) => void} */ resolve, reject) => {
              const handler = ({ payload }) => {
                payload.forEach(({ debugger: { diagnostics } }) => {
                  if (diagnostics.status !== 'ERROR') return
                  try {
                    assert.strictEqual(
                      diagnostics.exception.message,
                      'An object with more than 500 properties was detected while collecting a snapshot. Future ' +
                      'snapshots for exising probes in this location will be skipped until the Node.js process is ' +
                      'restarted'
                    )
                    resolve()
                  } catch (e) {
                    reject(e)
                  } finally {
                    t.agent.off('debugger-diagnostics', handler)
                  }
                })
              }
              t.agent.on('debugger-diagnostics', handler)
            })

            // Install probe with snapshot capture enabled
            t.agent.addRemoteConfig(breakpoint.generateRemoteConfig({
              captureSnapshot: true,
              capture: { maxReferenceDepth: 1 }
            }))

            // Trigger once; this run is expected to be slow and mark fields with "timeout"
            const result1 = await breakpoint.triggerBreakpoint()
            assert.ok(
              result1.data.paused >= 1_000,
              `expected thread to be paused for at least 1 second, but was paused for ~${result1.data.paused}ms`
            )
            const locals = await firstPayloadReceived
            assert.strictEqual(
              containsTimeBudget(locals),
              true,
              'expected at least one field/element to be marked with notCapturedReason: "timeout"'
            )
            await errorDiagnosticsReceived

            // Prepare to assert that no snapshot is produced on a subsequent trigger
            const noSnapshotAfterSecondTrigger = new Promise((/** @type {(value?: unknown) => void} */ resolve) => {
              t.agent.once('debugger-input', ({ payload: [{ debugger: { snapshot: { captures } } }] }) => {
                assert.strictEqual(captures, undefined)
                resolve()
              })
            })

            // Trigger the same breakpoint again directly
            const result2 = await t.axios.get(breakpoint.url)
            assert.ok(
              result2.data.paused <= 5,
              `expected thread to be paused <=5ms, but was paused for ~${result2.data.paused}ms`
            )

            await noSnapshotAfterSecondTrigger
          }
        )

        it(
          'should keep budget when state includes collections with 1 million elements',
          // A tolerance of 5ms is used to avoid flakiness
          test({ t, maxPausedTime: target + 5, breakpointIndex: 2, maxReferenceDepth: 1 }, (locals) => {
            assert.strictEqual(locals.arrOfPrimitives.notCapturedReason, 'collectionSize')
            assert.strictEqual(locals.arrOfPrimitives.size, 1_000_000)
            assert.strictEqual(locals.arrOfPrimitives.elements.length, 0)
            assert.strictEqual(locals.arrOfObjects.notCapturedReason, 'collectionSize')
            assert.strictEqual(locals.arrOfObjects.size, 1_000_000)
            assert.strictEqual(locals.arrOfObjects.elements.length, 0)
            assert.strictEqual(locals.map.notCapturedReason, 'collectionSize')
            assert.strictEqual(locals.map.size, 1_000_000)
            assert.strictEqual(locals.map.entries.length, 0)
            assert.strictEqual(locals.set.notCapturedReason, 'collectionSize')
            assert.strictEqual(locals.set.size, 1_000_000)
            assert.strictEqual(locals.set.elements.length, 0)
          })
        )

        it(
          'should keep budget when state includes collections with less than the size threshold',
          // A tolerance of 30ms is used to avoid flakiness
          test({ t, maxPausedTime: target + 30, breakpointIndex: 3, maxReferenceDepth: 1 }, (locals) => {
            assert.strictEqual(locals.arrOfPrimitives.notCapturedReason, 'collectionSize')
            assert.strictEqual(locals.arrOfPrimitives.size, COLLECTION_SIZE_THRESHOLD - 1)
            assert.strictEqual(locals.arrOfPrimitives.elements.length, DEFAULT_MAX_COLLECTION_SIZE)
            assert.strictEqual(locals.arrOfObjects.notCapturedReason, 'collectionSize')
            assert.strictEqual(locals.arrOfObjects.size, COLLECTION_SIZE_THRESHOLD - 1)
            assert.strictEqual(locals.arrOfObjects.elements.length, DEFAULT_MAX_COLLECTION_SIZE)
            assert.strictEqual(locals.map.notCapturedReason, 'collectionSize')
            assert.strictEqual(locals.map.size, COLLECTION_SIZE_THRESHOLD - 1)
            assert.strictEqual(locals.map.entries.length, DEFAULT_MAX_COLLECTION_SIZE)
            assert.strictEqual(locals.set.notCapturedReason, 'collectionSize')
            assert.strictEqual(locals.set.size, COLLECTION_SIZE_THRESHOLD - 1)
            assert.strictEqual(locals.set.elements.length, DEFAULT_MAX_COLLECTION_SIZE)
          })
        )
      })
    })
  })
})

function test ({ t, maxPausedTime = 0, breakpointIndex, maxReferenceDepth }, assertFn) {
  const breakpoint = t.breakpoints[breakpointIndex]

  return async function () {
    const payloadReceived = new Promise((/** @type {(value?: unknown) => void} */ resolve) => {
      t.agent.on('debugger-input', ({ payload: [{ debugger: { snapshot: { captures } } }] }) => {
        const { locals } = captures.lines[breakpoint.line]
        assertFn?.(locals)
        resolve()
      })
    })

    t.agent.addRemoteConfig(breakpoint.generateRemoteConfig({
      captureSnapshot: true,
      capture: { maxReferenceDepth }
    }))

    const { data } = await breakpoint.triggerBreakpoint()

    assert.ok(
      data.paused <= maxPausedTime,
      `expected thread to be paused <=${maxPausedTime}ms, but was paused for ~${data.paused}ms`
    )

    await payloadReceived
  }
}

function containsTimeBudget (node) {
  if (node == null || typeof node !== 'object') return false
  if (node.notCapturedReason === 'timeout') return true
  for (const value of Object.values(node)) {
    if (containsTimeBudget(value)) return true
  }
  return false
}
