'use strict'

const assert = require('node:assert')
const {
  DEFAULT_MAX_COLLECTION_SIZE,
  LARGE_OBJECT_SKIP_THRESHOLD,
} = require('../../packages/dd-trace/src/debugger/devtools_client/snapshot/constants')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  describe('input messages', function () {
    describe('with snapshot under time budget', function () {
      context('1ms time budget', function () {
        // Force a very small time budget in ms to trigger partial snapshots
        const budget = 1
        const t = setup({
          testApp: 'target-app/time-budget.js',
          dependencies: ['fastify'],
          env: { DD_DYNAMIC_INSTRUMENTATION_CAPTURE_TIMEOUT_MS: String(budget) },
        })

        it(
          'should include partial snapshot marked with notCapturedReason: timeout',
          // Timing is tested in unit tests with mocked time (collector-deadline.spec.js).
          // This integration test verifies the end-to-end behavior: that timeout markers
          // appear in snapshots when the budget is exceeded. We don't assert on exact timing
          // to avoid flakiness in CI environments where execution time is unpredictable.
          test({ t, breakpointIndex: 0, maxReferenceDepth: 5 }, (locals) => {
            assert.strictEqual(
              containsTimeBudget(locals),
              true,
              'expected at least one field/element to be marked with notCapturedReason: "timeout"'
            )
          })
        )
      })

      context('default time budget', function () {
        const t = setup({ testApp: 'target-app/time-budget.js', dependencies: ['fastify'] })

        it(
          'should timeout first, then disable subsequent snapshots and emit error diagnostics',
          async function () {
            const breakpoint = t.breakpoints[1]
            const expectedEvaluationErrors = [{
              expr: '',
              message: 'An object with 1000000 properties was detected while collecting a snapshot. This exceeds ' +
                `the maximum number of allowed properties of ${LARGE_OBJECT_SKIP_THRESHOLD}. Future snapshots for ` +
                'existing probes in this location will be skipped until the Node.js process is restarted',
            }]

            // Listen for the first snapshot payload (should contain notCapturedReason: "timeout")
            const firstPayloadReceived = new Promise(/** @type {() => void} */ (resolve) => {
              t.agent.once('debugger-input', ({ payload: [{ debugger: { snapshot } }] }) => {
                const { locals } = snapshot.captures.lines[breakpoint.line]
                assert.strictEqual(
                  containsTimeBudget(locals),
                  true,
                  'expected at least one field/element to be marked with notCapturedReason: "timeout"'
                )
                assert.deepStrictEqual(snapshot.evaluationErrors, expectedEvaluationErrors)
                resolve()
              })
            })

            // Install probe with snapshot capture enabled
            t.agent.addRemoteConfig(breakpoint.generateRemoteConfig({
              captureSnapshot: true,
              capture: { maxReferenceDepth: 1 },
            }))

            // Trigger once; this run is expected to be slow and mark fields with "timeout"
            const result1 = /** @type {import('axios').AxiosResponse<{ paused: number }>} */
              (await breakpoint.triggerBreakpoint())
            assert.ok(
              result1.data.paused >= 1_000,
              `expected thread to be paused for at least 1 second, but was paused for ~${result1.data.paused}ms`
            )

            await firstPayloadReceived

            // Prepare to assert that no snapshot is produced on a subsequent trigger
            const secondPayloadReceived = new Promise(/** @type {() => void} */ (resolve) => {
              t.agent.once('debugger-input', ({ payload: [{ debugger: { snapshot } }] }) => {
                assert.ok(!Object.hasOwn(snapshot, 'captures'))
                assert.deepStrictEqual(snapshot.evaluationErrors, expectedEvaluationErrors)
                resolve()
              })
            })

            // Trigger the same breakpoint again directly
            const result2 = await t.axios.get(breakpoint.url)
            assert.ok(
              result2.data.paused <= 50,
              `expected thread to be paused <=50ms, but was paused for ~${result2.data.paused}ms`
            )

            await secondPayloadReceived
          }
        )
      })

      context('large object thresholds', function () {
        // The tests in this group, should take a lot longer than 100ms to capture a snapshot if no thresholds are
        // applied. But they should take a lot less than the 100ms budget if thresholds are applied. Using 100ms means
        // that the tests should not be flaky, but still fail if the thresholds are not applied.
        const budget = 100
        const t = setup({
          testApp: 'target-app/time-budget.js',
          dependencies: ['fastify'],
          env: { DD_DYNAMIC_INSTRUMENTATION_CAPTURE_TIMEOUT_MS: String(budget) },
        })

        it(
          'should keep budget when state includes collections with 1 million elements',
          test({ t, maxPausedTime: budget, breakpointIndex: 2, maxReferenceDepth: 1 }, (locals) => {
            const notCapturedReason = `Large collection with too many elements (skip threshold: ${
              LARGE_OBJECT_SKIP_THRESHOLD
            })`
            assert.strictEqual(locals.arrOfPrimitives.notCapturedReason, notCapturedReason)
            assert.strictEqual(locals.arrOfPrimitives.size, 1_000_000)
            assert.strictEqual(locals.arrOfPrimitives.elements.length, 0)
            assert.strictEqual(locals.arrOfObjects.notCapturedReason, notCapturedReason)
            assert.strictEqual(locals.arrOfObjects.size, 1_000_000)
            assert.strictEqual(locals.arrOfObjects.elements.length, 0)
            assert.strictEqual(locals.map.notCapturedReason, notCapturedReason)
            assert.strictEqual(locals.map.size, 1_000_000)
            assert.strictEqual(locals.map.entries.length, 0)
            assert.strictEqual(locals.set.notCapturedReason, notCapturedReason)
            assert.strictEqual(locals.set.size, 1_000_000)
            assert.strictEqual(locals.set.elements.length, 0)
          })
        )

        it(
          'should keep budget when state includes collections with less than the size threshold',
          test({ t, maxPausedTime: budget, breakpointIndex: 3, maxReferenceDepth: 1 }, (locals) => {
            assert.strictEqual(locals.arrOfPrimitives.notCapturedReason, 'collectionSize')
            assert.strictEqual(locals.arrOfPrimitives.size, LARGE_OBJECT_SKIP_THRESHOLD - 1)
            assert.strictEqual(locals.arrOfPrimitives.elements.length, DEFAULT_MAX_COLLECTION_SIZE)
            assert.strictEqual(locals.arrOfObjects.notCapturedReason, 'collectionSize')
            assert.strictEqual(locals.arrOfObjects.size, LARGE_OBJECT_SKIP_THRESHOLD - 1)
            assert.strictEqual(locals.arrOfObjects.elements.length, DEFAULT_MAX_COLLECTION_SIZE)
            assert.strictEqual(locals.map.notCapturedReason, 'collectionSize')
            assert.strictEqual(locals.map.size, LARGE_OBJECT_SKIP_THRESHOLD - 1)
            assert.strictEqual(locals.map.entries.length, DEFAULT_MAX_COLLECTION_SIZE)
            assert.strictEqual(locals.set.notCapturedReason, 'collectionSize')
            assert.strictEqual(locals.set.size, LARGE_OBJECT_SKIP_THRESHOLD - 1)
            assert.strictEqual(locals.set.elements.length, DEFAULT_MAX_COLLECTION_SIZE)
          })
        )
      })

      context('fuzzing', function () {
        for (let budget = 0; budget < 20; budget++) {
          context(`graceful handling with time budget of ${budget}ms`, function () {
            // Anything longer than this, and the debugger worker thread most likely crashed.
            // Run test with `DD_TRACE_DEBUG=true` to see more.
            this.timeout(2000)

            const t = setup({
              testApp: 'target-app/time-budget.js',
              dependencies: ['fastify'],
              env: { DD_DYNAMIC_INSTRUMENTATION_CAPTURE_TIMEOUT_MS: String(budget) },
            })

            // If this test uncovers any issues, it will show itself as being flaky, as the exact timing of how long it
            // takes to collect the snapshot is not deterministic.
            it('should send a probe result to the agent', async function () {
              t.agent.addRemoteConfig(t.generateRemoteConfig({
                captureSnapshot: true,
                capture: { maxReferenceDepth: 5 },
              }))
              t.triggerBreakpoint()

              const { captures } = await t.snapshotReceived()
              // If the snapshot contains a `captures` field, it means it was captured and processes without any issues
              assert.ok(
                captures !== null && typeof captures === 'object',
                'expected snapshot to contain a `captures` object'
              )
              // To make this test more future-proof, we also assert that the snapshot contains at least one local
              // property, though currently this is not necessary.
              assert.ok(
                Object.keys(captures.lines[t.breakpoint.line].locals).length > 0,
                'expected snapshot to contain at least one local property'
              )
            })
          })
        }
      })
    })
  })
})

/**
 * @param {object} config
 * @param {object} config.t - Test environment
 * @param {number} [config.maxPausedTime] - Optional maximum pause time in ms (skips timing assertion if not provided)
 * @param {number} config.breakpointIndex - Index of the breakpoint to test
 * @param {number} config.maxReferenceDepth - Maximum reference depth for snapshot
 * @param {Function} [assertFn] - Optional assertion function for the snapshot locals
 */
function test ({ t, maxPausedTime, breakpointIndex, maxReferenceDepth }, assertFn) {
  const breakpoint = t.breakpoints[breakpointIndex]

  return async function () {
    const snapshotPromise = t.snapshotReceived()

    t.agent.addRemoteConfig(breakpoint.generateRemoteConfig({
      captureSnapshot: true,
      capture: { maxReferenceDepth },
    }))

    const { data } = await breakpoint.triggerBreakpoint()

    if (maxPausedTime !== undefined) {
      assert.ok(
        data.paused <= maxPausedTime,
        `expected thread to be paused <=${maxPausedTime}ms, but was paused for ~${data.paused}ms`
      )
    }

    const snapshot = await snapshotPromise
    assertFn?.(snapshot.captures.lines[breakpoint.line].locals)
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
