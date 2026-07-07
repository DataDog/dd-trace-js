'use strict'

const assert = require('node:assert')

const { channel } = require('dc-polyfill')

const finishCh = channel('dd-trace:span:finish')

// A finished span's retention must not scale with the number of requests. The
// classic violation is an async-context frame that captured a `{ ...store, span }`
// object (see `Plugin#enter`): the frame outlives the request via any
// never-released async resource and pins the finished span and its whole parent
// chain, so retained spans grow one-per-request until the process OOMs
// (DataDog/dd-trace-js#9227).
//
// This detector rides along on every suite that runs with `--expose-gc`: it
// registers each finished span with a FinalizationRegistry and, at agent
// teardown, forces GC and asserts retention did not grow with the request count.
// It is a no-op without `--expose-gc`, so suites that do not pass the flag are
// unaffected.
//
// Why the bound is a small constant, not zero: a span stores the async-context
// frame it was created in (`span._store = storage('legacy').getHandle()`, see
// `opentracing/span.js`). That frame is `{ ...parent, span }`, so a trace's spans
// form a reference cycle (`span._store -> store -> span`) that stays reachable
// until a *later* frame overwrites that async-context slot. At teardown the few
// most-recently-created traces' frames have not been overwritten yet, so their
// roots can still be alive. This is bounded by recency, not by request count:
// driving 100 sequential requests through the mock-agent harness collects every
// root (`retained === 0`), and a wide sweep of the http/http2 suites never
// retained more than two (only the 1-2 requests a test makes right before its
// teardown). A real leak like #9227 pins one span per request for the life of the
// process, so `retained` climbs into the dozens or hundreds and trips the cap.

const gc = typeof global.gc === 'function' ? global.gc : undefined

/**
 * Number of forced-GC + drain cycles before giving up. FinalizationRegistry
 * callbacks are scheduled after collection and V8 may need more than one pass,
 * so poll rather than assert after a single GC.
 */
const MAX_GC_CYCLES = 10

/**
 * Upper bound on finished spans that may still be reachable at teardown without
 * indicating a leak. Benign retention is the handful of most-recent traces whose
 * async-context frames have not been overwritten yet (see above); a sweep of the
 * http/http2 suites topped out at two, so this is that measured maximum plus one
 * slot of margin. It is an absolute cap, not a per-request allowance: a #9227-style
 * leak retains one span per request and blows past it by orders of magnitude, so
 * the margin costs no detection power.
 */
const BASELINE_RETAINED = 3

class SpanLeakDetector {
  #registry
  #trackedCount = 0
  #collectedCount = 0
  #armed = false
  #onFinish = span => {
    this.#trackedCount++
    this.#registry.register(span)
  }

  /**
   * Whether span-retention checking is possible in this process. Requires
   * `--expose-gc`; the detector is inert otherwise.
   *
   * @returns {boolean}
   */
  get enabled () {
    return gc !== undefined
  }

  /**
   * Start tracking finished spans. Idempotent so repeated `agent.load` calls in
   * one suite do not double-subscribe (which would inflate the tracked count and
   * leak the finish handler across load/close cycles).
   *
   * @returns {void}
   */
  arm () {
    if (!this.enabled || this.#armed) return
    // Lazily create the registry so processes without `--expose-gc` never build
    // one. The callback only counts; it must not retain the span.
    this.#registry ??= new FinalizationRegistry(() => {
      this.#collectedCount++
    })
    finishCh.subscribe(this.#onFinish)
    this.#armed = true
  }

  /**
   * Force GC and assert that finished-span retention has not grown with the
   * request count. Call once the tracer has flushed and no test-owned reference
   * to a span remains (i.e. at agent teardown, after expectation callbacks are
   * cleared). Up to {@link BASELINE_RETAINED} spans may survive (the few
   * most-recent traces' roots, still held by their `span._store` cycle); more
   * than that means a tracer-owned structure is pinning finished spans
   * one-per-request. Resets counters so the next suite starts clean. No-op when
   * the detector is inert or nothing was tracked.
   *
   * @returns {Promise<void>}
   */
  async assertNoRetainedSpans () {
    if (!this.#armed) return

    finishCh.unsubscribe(this.#onFinish)
    this.#armed = false

    if (this.#trackedCount === 0) {
      this.#reset()
      return
    }

    // Let any pending flush / microtasks settle, then force GC and give the
    // registry callbacks a turn. Repeat until retention is within the baseline or
    // the cycle budget is spent (polling because FinalizationRegistry callbacks
    // run after collection and V8 may need more than one pass).
    for (
      let cycle = 0;
      cycle < MAX_GC_CYCLES && this.#trackedCount - this.#collectedCount > BASELINE_RETAINED;
      cycle++
    ) {
      await new Promise(resolve => setImmediate(resolve))
      gc()
    }
    await new Promise(resolve => setImmediate(resolve))

    const retained = this.#trackedCount - this.#collectedCount
    const tracked = this.#trackedCount
    this.#reset()

    assert.ok(
      retained <= BASELINE_RETAINED,
      `${retained} of ${tracked} finished spans were still reachable after flush + GC ` +
      `(at most ${BASELINE_RETAINED} may survive as recently-created traces whose async-context ` +
      'frames have not been overwritten yet). Retention is growing with the request count — a ' +
      'tracer-owned structure is pinning finished spans, commonly an async-context frame that ' +
      'captured a `{ ...store, span }` object without a matching `releaseSpan` ' +
      '(see DataDog/dd-trace-js#9227).'
    )
  }

  #reset () {
    this.#trackedCount = 0
    this.#collectedCount = 0
  }
}

module.exports = new SpanLeakDetector()
// Exposed for the detector's own spec, which asserts both the retained and the
// freed outcome against fresh instances without a real agent teardown.
module.exports.SpanLeakDetector = SpanLeakDetector
