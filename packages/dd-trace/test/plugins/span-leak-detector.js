'use strict'

const assert = require('node:assert')

const { channel } = require('dc-polyfill')
const { after, before } = require('mocha')

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
 * Default upper bound on finished spans that may still be reachable at teardown
 * without indicating a leak. Benign retention has two sources: the handful of
 * most-recent traces whose async-context frames have not been overwritten yet
 * (see above), and the small residue that survives `releaseKeepAliveRetainers`
 * on HTTP-server suites (a middleware `next` closure still holding the last
 * request's `req`). Both are recency-bounded, not per-request: an http-suite
 * sweep tops out at a handful, so 10 covers it with margin. It is an absolute
 * cap, not a per-request allowance — a #9227-style leak retains one span per
 * request and blows past 10 by orders of magnitude, so the margin costs no
 * detection power.
 *
 * A few suites exercise upstream libraries that pin a *fixed* number of finished
 * spans regardless of request count, through a retainer `closeIdleConnections`
 * cannot reach — e.g. `@grpc/grpc-js` keeps a cleared `Timeout` on each pooled
 * `Subchannel`, and under AsyncContextFrame that timer retains the
 * `{ ...store, span }` frame active when the subchannel was built. That retention
 * does not scale, but it exceeds the default, so those suites raise the bound
 * with {@link SpanLeakDetector#withSpanLeakBaseline}, keeping the tight default
 * for every other suite.
 */
const BASELINE_RETAINED = 10

/**
 * Close idle connections on every live HTTP/net server so their per-connection
 * keep-alive timers stop pinning finished spans. Node arms a keep-alive/headers
 * `Timeout` per connection; under AsyncContextFrame that timer's callback closes
 * over the `{ ...store, span }` frame active when the request ran, and it stays in
 * the active-timer list — reachable from the still-open `Server` — until it fires.
 * That is the dominant retainer for HTTP-server suites (express, fastify, koa,
 * connect, the AppSec/IAST specs). Releasing it at the source lets those suites
 * keep the tight default instead of each raising a baseline for benign residue.
 *
 * Best-effort: `_getActiveHandles` is internal and its entries vary by Node
 * version, so guard every access. `closeIdleConnections` (Node >=18.2) only drops
 * sockets with no in-flight request, so it never interrupts real work; the
 * assertion runs at agent teardown, after the suite's requests have completed.
 *
 * @returns {void}
 */
function releaseKeepAliveRetainers () {
  const handles = process._getActiveHandles?.()
  if (handles === undefined) return

  for (const handle of handles) {
    handle?.closeIdleConnections?.()
  }
}

class SpanLeakDetector {
  #registry
  #trackedCount = 0
  #collectedCount = 0
  #armed = false
  #baseline = BASELINE_RETAINED
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
   * Number of finished spans seen since the detector was last reset. Reused by
   * the global test hooks to detect per-test span activity without adding a
   * second subscriber to `dd-trace:span:finish` (a bare `channel(...).subscribe`
   * would flip `hasSubscribers`, which some unit tests assert on). Zero when the
   * detector is inert or unarmed.
   *
   * @returns {number}
   */
  trackedCount () {
    return this.#trackedCount
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
   * Raise (or lower) the retention bound for a suite whose upstream dependency
   * pins a fixed, non-scaling number of finished spans (see {@link BASELINE_RETAINED}).
   * Call in a `before` hook and undo with {@link SpanLeakDetector#resetBaseline}
   * in `after` so the tight default still guards every other suite. The bound is
   * an absolute cap, so pick the smallest value that clears the known
   * pool-sized retention — a real per-request leak still scales past it.
   *
   * @param {number} limit Maximum reachable finished spans to tolerate.
   * @returns {void}
   */
  setBaseline (limit) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new TypeError(`span-leak baseline must be a non-negative integer, got ${limit}`)
    }
    this.#baseline = limit
  }

  /**
   * Restore the default retention bound. Pair with
   * {@link SpanLeakDetector#setBaseline} in the same suite's `after` hook.
   *
   * @returns {void}
   */
  resetBaseline () {
    this.#baseline = BASELINE_RETAINED
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

    releaseKeepAliveRetainers()

    // Let any pending flush / microtasks settle, then force GC and give the
    // registry callbacks a turn. Repeat until retention is within the baseline or
    // the cycle budget is spent (polling because FinalizationRegistry callbacks
    // run after collection and V8 may need more than one pass).
    for (
      let cycle = 0;
      cycle < MAX_GC_CYCLES && this.#trackedCount - this.#collectedCount > this.#baseline;
      cycle++
    ) {
      await new Promise(resolve => setImmediate(resolve))
      gc()
    }
    await new Promise(resolve => setImmediate(resolve))

    const retained = this.#trackedCount - this.#collectedCount
    const tracked = this.#trackedCount
    const baseline = this.#baseline
    this.#reset()

    assert.ok(
      retained <= baseline,
      `${retained} of ${tracked} finished spans were still reachable after flush + GC ` +
      `(at most ${baseline} may survive as recently-created traces whose async-context ` +
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

const detector = new SpanLeakDetector()

/**
 * Register mocha hooks that raise the retention bound for the enclosing suite
 * and restore the default afterwards. For suites whose upstream dependency pins
 * a fixed, non-scaling number of finished spans through a pending timer or
 * pooled handle (see {@link BASELINE_RETAINED}): the count exceeds the tight
 * default but does not grow per request, so it is not the leak the detector
 * hunts. Call once at the top of the suite's `describe`.
 *
 * @param {number} limit Maximum reachable finished spans to tolerate in the suite.
 * @returns {void}
 */
function withSpanLeakBaseline (limit) {
  before(() => detector.setBaseline(limit))
  after(() => detector.resetBaseline())
}

module.exports = detector
module.exports.withSpanLeakBaseline = withSpanLeakBaseline
// Exposed for the detector's own spec, which asserts both the retained and the
// freed outcome against fresh instances without a real agent teardown.
module.exports.SpanLeakDetector = SpanLeakDetector
