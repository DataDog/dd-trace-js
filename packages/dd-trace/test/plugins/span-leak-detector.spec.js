'use strict'

const assert = require('node:assert')

const { describe, it } = require('mocha')
const { channel } = require('dc-polyfill')

const { SpanLeakDetector } = require('./span-leak-detector')

const finishCh = channel('dd-trace:span:finish')

if (typeof global.gc !== 'function') {
  throw new Error('span-leak-detector.spec.js requires --expose-gc')
}

// Pins the retention contract the agent-teardown check relies on: retention that
// grows with the request count must be reported as a leak, while the small,
// recency-bounded baseline (the few most-recent traces whose async-context frames
// have not been overwritten yet) must pass. The detector tolerates up to
// BASELINE_RETAINED (3) survivors — a measured maximum of two across the http
// suites plus one slot of margin — so the boundary cases below pin 3 (accepted)
// and 4 (the first rejected). Uses fresh detector instances (not the agent
// singleton) so every outcome can be asserted without a real teardown.

const BASELINE_RETAINED = 3

async function forceGc () {
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setImmediate(resolve))
    global.gc()
  }
}

/**
 * Publish `count` finish events for spans held by strong references, mirroring
 * finished spans pinned by a never-released async-context frame. The references
 * are returned so the caller keeps them live across the assertion.
 *
 * @param {number} count
 * @returns {Array<{ _name: string }>}
 */
function publishRetained (count) {
  const spans = []
  for (let i = 0; i < count; i++) {
    const span = { _name: `leaked.span.${i}` }
    spans.push(span)
    finishCh.publish(span)
  }
  return spans
}

describe('span-leak-detector', () => {
  it('tolerates retention at the baseline (the recency-bounded roots)', async () => {
    const detector = new SpanLeakDetector()
    detector.arm()

    // Exactly BASELINE_RETAINED survivors mirror the last few traces' roots still
    // held by their `span._store` cycle at teardown; bounded, not a leak.
    const baselineSpans = publishRetained(BASELINE_RETAINED)

    await detector.assertNoRetainedSpans()
    assert.strictEqual(baselineSpans.length, BASELINE_RETAINED)
  })

  it('reports a leak when retention exceeds the baseline by one', async () => {
    const detector = new SpanLeakDetector()
    detector.arm()

    // One past the baseline is the smallest retention that indicates growth with
    // the request count rather than the bounded recency window.
    const retainedSpans = publishRetained(BASELINE_RETAINED + 1)

    await assert.rejects(
      () => detector.assertNoRetainedSpans(),
      new RegExp(`${BASELINE_RETAINED + 1} of ${BASELINE_RETAINED + 1} finished spans were still reachable`)
    )

    // References stay live through the assertion, mirroring a captured frame.
    assert.strictEqual(retainedSpans.length, BASELINE_RETAINED + 1)
  })

  it('reports no retention when nothing holds the finished span', async () => {
    const detector = new SpanLeakDetector()
    detector.arm()

    // Publish a span held by nothing so no reference survives to the assertion.
    ;(() => finishCh.publish({ _name: 'collectable.span' }))()

    await forceGc()
    await detector.assertNoRetainedSpans()
  })

  it('is a no-op when armed but nothing was tracked', async () => {
    const detector = new SpanLeakDetector()
    detector.arm()

    await detector.assertNoRetainedSpans()
  })

  it('is a no-op when never armed', async () => {
    const detector = new SpanLeakDetector()

    await detector.assertNoRetainedSpans()
  })

  it('does not double-count finished spans when armed twice', async () => {
    const detector = new SpanLeakDetector()
    detector.arm()
    detector.arm()

    // Spans must be counted once each, not once per arm() call — otherwise a
    // repeated agent.load in one suite would inflate the count and leak the finish
    // handler. Publish one past the baseline so the (correct) count still trips
    // the assertion; a double-count would report twice as many.
    const retainedSpans = publishRetained(BASELINE_RETAINED + 1)

    await assert.rejects(
      () => detector.assertNoRetainedSpans(),
      new RegExp(`${BASELINE_RETAINED + 1} of ${BASELINE_RETAINED + 1} finished spans were still reachable`)
    )
    assert.strictEqual(retainedSpans.length, BASELINE_RETAINED + 1)
  })
})
