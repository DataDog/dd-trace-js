'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
require('../setup/mocha')

const {
  CONDITION_ERROR_FLAG,
  CONDITION_ERROR_THROTTLE_NS,
  MAX_SAMPLED_PROBES_PER_PAUSE,
  SAMPLED_PROBE_COUNT_INDEX,
  SAMPLED_PROBE_INDEXES_START,
  SAMPLED_PROBE_OVERFLOW_INDEX,
} = require('../../src/debugger/probe_sampler_constants')
const { GuardrailMetrics } = require('../../src/debugger/guardrail-metrics')
const { installProbeSampler, uninstallProbeSampler } = require('../../src/debugger/probe_sampler')
const {
  compileBreakpointCondition,
  getRemoveProbeExpression,
  getTakeConditionErrorExpression,
} = require('../../src/debugger/devtools_client/probe_sampler')
const { MAX_SNAPSHOTS_PER_SECOND_GLOBALLY } = require('../../src/debugger/devtools_client/defaults')

const ddTraceSymbol = Symbol.for('dd-trace')
const samplerSymbol = Symbol.for('dd-trace.debugger.probeSampler')

/**
 * @typedef {object} RuntimeSampler
 * @property {Function} makeSampleDecision
 * @property {Function} shouldEvaluateCondition
 * @property {Function} conditionError
 * @property {Function} takeConditionError
 * @property {Function} remove
 */

/** @type {GuardrailMetrics} */
let guardrailMetrics

describe('probe sampler', function () {
  /** @type {typeof process.hrtime.bigint} */
  let originalHrtimeBigint
  /** @type {bigint} */
  let now

  beforeEach(function () {
    delete getDatadogGlobal()[samplerSymbol]
    guardrailMetrics = new GuardrailMetrics(GuardrailMetrics.createBuffer())
    originalHrtimeBigint = process.hrtime.bigint
    now = 1_000_000_000n
    process.hrtime.bigint = () => now
  })

  afterEach(function () {
    process.hrtime.bigint = originalHrtimeBigint
    delete getDatadogGlobal()[samplerSymbol]
  })

  describe('shared buffer', function () {
    it('should create a shared buffer with the expected layout', function () {
      const buffer = installProbeSampler(guardrailMetrics)
      const sampledProbeIndexes = new Int32Array(buffer)

      assert(buffer instanceof SharedArrayBuffer)
      assert.strictEqual(sampledProbeIndexes.length, SAMPLED_PROBE_INDEXES_START + MAX_SAMPLED_PROBES_PER_PAUSE)
    })

    it('should initialize the shared buffer', function () {
      const installedBuffer = installProbeSampler(guardrailMetrics)
      const installedSampledProbeIndexes = new Int32Array(installedBuffer)

      assert.strictEqual(Atomics.load(installedSampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 0)
      assert.strictEqual(Atomics.load(installedSampledProbeIndexes, SAMPLED_PROBE_OVERFLOW_INDEX), 0)
    })

    it('should remove the runtime sampler', function () {
      installSampler()
      uninstallProbeSampler()

      assert.strictEqual(getDatadogGlobal()[samplerSymbol], undefined)
    })
  })

  describe('generated expressions', function () {
    it('should compile a breakpoint condition for probes without conditions', function () {
      assert.strictEqual(compileBreakpointCondition([
        { id: 'probe-1', samplingIndex: 0, nsBetweenSampling: 200000n },
        { id: 'probe-2', samplingIndex: 1, nsBetweenSampling: 200000n },
      ]), `(() => {
    const $dd_sampler = globalThis[Symbol.for("dd-trace")]?.[Symbol.for("dd-trace.debugger.probeSampler")]
    if ($dd_sampler === undefined) return false
    let $dd_sampled = false
    $dd_sampled = $dd_sampler.makeSampleDecision(0, "probe-1", 200000n, false) || $dd_sampled
    $dd_sampled = $dd_sampler.makeSampleDecision(1, "probe-2", 200000n, false) || $dd_sampled
    return $dd_sampled
  })()`)
    })

    it('should compile a breakpoint condition for probes with conditions and snapshot capture', function () {
      assert.strictEqual(compileBreakpointCondition([
        {
          id: 'probe-1',
          samplingIndex: 0,
          nsBetweenSampling: 200000n,
          condition: '(foo) === (42)',
          captureSnapshot: true,
        },
      ]), `(() => {
    const $dd_sampler = globalThis[Symbol.for("dd-trace")]?.[Symbol.for("dd-trace.debugger.probeSampler")]
    if ($dd_sampler === undefined) return false
    let $dd_sampled = false
    if ($dd_sampler.shouldEvaluateCondition("probe-1")) {
      try {
        if (((foo) === (42)) === true) {
          $dd_sampled = $dd_sampler.makeSampleDecision(0, "probe-1", 200000n, true) || $dd_sampled
        }
      } catch ($dd_error) {
        $dd_sampled = $dd_sampler.conditionError(0, "probe-1", $dd_error) ||
          $dd_sampled
      }
    }
    return $dd_sampled
  })()`)
    })

    it('should compile an expression that removes probe sampler state', function () {
      assert.strictEqual(getRemoveProbeExpression('probe-1'),
        'globalThis[Symbol.for("dd-trace")]?.[Symbol.for("dd-trace.debugger.probeSampler")]?.remove("probe-1")')
    })

    it('should compile an expression that takes the recorded condition error of a probe', function () {
      assert.strictEqual(getTakeConditionErrorExpression('probe-1'),
        'globalThis[Symbol.for("dd-trace")]?.[Symbol.for("dd-trace.debugger.probeSampler")]' +
        '?.takeConditionError("probe-1")')
    })

    it('should pause for a condition error and skip the condition until the throttle window has passed', function () {
      installSampler()
      const sampler = getSampler()
      const probes = [{ id: 'probe-1', samplingIndex: 0, nsBetweenSampling: 0n, condition: 'foo.bar' }]
      const breakpointCondition = compileBreakpointCondition(probes)
      const evaluate = () => {
        // eslint-disable-next-line no-new-func
        return new Function('foo', `return ${breakpointCondition}`)(undefined)
      }

      assert.strictEqual(evaluate(), true, 'should pause to report the error')
      assert.strictEqual(
        sampler.takeConditionError('probe-1'),
        "TypeError: Cannot read properties of undefined (reading 'bar')"
      )
      assert.strictEqual(evaluate(), false, 'should skip the condition while throttled')

      now += CONDITION_ERROR_THROTTLE_NS
      assert.strictEqual(evaluate(), true, 'should evaluate the condition again once the throttle window has passed')
    })
  })

  describe('runtime sampler', function () {
    it('should install the runtime sampler when the buffer is present', function () {
      installSampler()

      assert.strictEqual(typeof getSampler().makeSampleDecision, 'function')
      assert.strictEqual(typeof getSampler().remove, 'function')
    })

    it('should reinstall the runtime sampler with the latest shared buffer', function () {
      const firstSampledProbeIndexes = installSampler()

      const secondSampledProbeIndexes = installSampler()

      assert.strictEqual(getSampler().makeSampleDecision(7, 'probe-1', 200000n, false), true)
      assert.strictEqual(Atomics.load(firstSampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 0)
      assert.strictEqual(Atomics.load(secondSampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 1)
      assert.strictEqual(Atomics.load(secondSampledProbeIndexes, SAMPLED_PROBE_INDEXES_START), 7)
    })

    it('should sample a probe and write its index to the shared buffer', function () {
      const sampledProbeIndexes = installSampler()

      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 0)
      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_INDEXES_START), 0)

      const sampled = getSampler().makeSampleDecision(7, 'probe-1', 200000n, false)

      assert.strictEqual(sampled, true)
      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 1)
      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_INDEXES_START), 7)
    })

    it('should skip repeated hits within the sampling interval', function () {
      const sampledProbeIndexes = installSampler()
      const sampler = getSampler()
      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 0)

      assert.strictEqual(sampler.makeSampleDecision(7, 'probe-1', 200000n, false), true)
      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 1)

      now += 100000n

      assert.strictEqual(sampler.makeSampleDecision(7, 'probe-1', 200000n, false), false)
      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 1)
      assert.deepStrictEqual(drainGuardrailMetrics(), [
        ['events.skipped', ['event_type:log', 'reason:rateLimitProbe'], 1],
      ])
    })

    it('should count snapshot-producing probes skipped by the per-probe rate limit as snapshots', function () {
      installSampler()
      const sampler = getSampler()

      assert.strictEqual(sampler.makeSampleDecision(7, 'probe-1', 200000n, true), true)
      assert.strictEqual(sampler.makeSampleDecision(7, 'probe-1', 200000n, true), false)
      assert.strictEqual(sampler.makeSampleDecision(7, 'probe-1', 200000n, true), false)

      assert.deepStrictEqual(drainGuardrailMetrics(), [
        ['events.skipped', ['event_type:snapshot', 'reason:rateLimitProbe'], 2],
      ])
    })

    it('should allow a removed probe to sample again immediately', function () {
      const sampledProbeIndexes = installSampler()
      const sampler = getSampler()
      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 0)

      assert.strictEqual(sampler.makeSampleDecision(7, 'probe-1', 200000n, false), true)
      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 1)

      sampler.remove('probe-1')

      assert.strictEqual(sampler.makeSampleDecision(7, 'probe-1', 200000n, false), true)
      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 2)
    })

    it('should apply the global snapshot sample rate only to snapshot-producing probes', function () {
      const sampledProbeIndexes = installSampler()
      const sampler = getSampler()
      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 0)

      for (let i = 0; i < MAX_SNAPSHOTS_PER_SECOND_GLOBALLY; i++) {
        assert.strictEqual(sampler.makeSampleDecision(i, `snapshot-${i}`, 0n, true), true)
      }

      assert.strictEqual(sampler.makeSampleDecision(99, 'snapshot-over-limit', 0n, true), false)
      assert.strictEqual(sampler.makeSampleDecision(100, 'non-snapshot', 0n, false), true)
      assert.strictEqual(
        Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX),
        MAX_SNAPSHOTS_PER_SECOND_GLOBALLY + 1
      )
      assert.deepStrictEqual(drainGuardrailMetrics(), [
        ['events.skipped', ['event_type:snapshot', 'reason:rateLimitGlobal'], 1],
      ])
    })

    it('should not advance the sampled probe count when global snapshot rate rejects a probe', function () {
      const sampledProbeIndexes = installSampler()
      const sampler = getSampler()

      for (let i = 0; i < MAX_SNAPSHOTS_PER_SECOND_GLOBALLY; i++) {
        assert.strictEqual(sampler.makeSampleDecision(i, `snapshot-${i}`, 0n, true), true)
      }
      assert.strictEqual(
        Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX),
        MAX_SNAPSHOTS_PER_SECOND_GLOBALLY
      )

      assert.strictEqual(sampler.makeSampleDecision(99, 'snapshot-over-limit', 0n, true), false)
      assert.strictEqual(
        Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX),
        MAX_SNAPSHOTS_PER_SECOND_GLOBALLY
      )
    })

    it('should reset the global snapshot sample rate after one second', function () {
      installSampler()
      const sampler = getSampler()

      for (let i = 0; i < MAX_SNAPSHOTS_PER_SECOND_GLOBALLY; i++) {
        assert.strictEqual(sampler.makeSampleDecision(i, `snapshot-${i}`, 0n, true), true)
      }

      now += 1_000_000_001n
      assert.strictEqual(sampler.makeSampleDecision(99, 'snapshot-next-window', 0n, true), true)
      assert.deepStrictEqual(drainGuardrailMetrics(), [])
    })

    describe('condition errors', function () {
      it('should evaluate conditions of probes without a recorded error', function () {
        installSampler()

        assert.strictEqual(getSampler().shouldEvaluateCondition('probe-1'), true)
      })

      it('should request a pause flagged as a condition error', function () {
        const sampledProbeIndexes = installSampler()
        const sampler = getSampler()

        assert.strictEqual(sampler.conditionError(7, 'probe-1', new TypeError('boom')), true)
        assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 1)
        assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_INDEXES_START), 7 | CONDITION_ERROR_FLAG)
      })

      it('should hand over the recorded error once', function () {
        installSampler()
        const sampler = getSampler()

        sampler.conditionError(7, 'probe-1', new TypeError('boom'))

        assert.strictEqual(sampler.takeConditionError('probe-1'), 'TypeError: boom')
        assert.strictEqual(sampler.takeConditionError('probe-1'), undefined)
        assert.strictEqual(sampler.takeConditionError('unknown-probe'), undefined)
      })

      it('should describe non-error values thrown by a condition', function () {
        installSampler()
        const sampler = getSampler()

        sampler.conditionError(7, 'probe-1', 'a string')
        assert.strictEqual(sampler.takeConditionError('probe-1'), 'a string')

        sampler.conditionError(7, 'probe-1', { not: 'an error' })
        assert.strictEqual(sampler.takeConditionError('probe-1'), 'Unknown evaluation error')
      })

      it('should throttle condition evaluation for the throttle window after an error', function () {
        installSampler()
        const sampler = getSampler()

        sampler.conditionError(7, 'probe-1', new TypeError('boom'))

        assert.strictEqual(sampler.shouldEvaluateCondition('probe-1'), false)
        assert.strictEqual(sampler.shouldEvaluateCondition('probe-2'), true, 'should not affect other probes')
        now += CONDITION_ERROR_THROTTLE_NS - 1n
        assert.strictEqual(sampler.shouldEvaluateCondition('probe-1'), false)
        now += 1n
        assert.strictEqual(sampler.shouldEvaluateCondition('probe-1'), true)
      })

      it('should not apply the per-probe or global rate limits to condition errors', function () {
        const sampledProbeIndexes = installSampler()
        const sampler = getSampler()

        for (let i = 0; i < MAX_SNAPSHOTS_PER_SECOND_GLOBALLY; i++) {
          assert.strictEqual(sampler.makeSampleDecision(i, `snapshot-${i}`, 0n, true), true)
        }
        assert.strictEqual(sampler.makeSampleDecision(99, 'probe-1', 1_000_000_000n, true), false)

        assert.strictEqual(sampler.conditionError(99, 'probe-1', new Error('boom')), true)
        assert.strictEqual(
          Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX),
          MAX_SNAPSHOTS_PER_SECOND_GLOBALLY + 1
        )
      })

      it('should skip the condition error when the shared buffer is full', function () {
        const sampledProbeIndexes = installSampler()
        Atomics.store(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX, MAX_SAMPLED_PROBES_PER_PAUSE)

        assert.strictEqual(getSampler().conditionError(7, 'probe-1', new Error('boom')), false)
        assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_OVERFLOW_INDEX), 1)
      })

      it('should forget the recorded error and throttle when a probe is removed', function () {
        installSampler()
        const sampler = getSampler()

        sampler.conditionError(7, 'probe-1', new Error('boom'))
        sampler.remove('probe-1')

        assert.strictEqual(sampler.shouldEvaluateCondition('probe-1'), true)
        assert.strictEqual(sampler.takeConditionError('probe-1'), undefined)
      })
    })

    it('should set overflow and skip probes when the shared buffer is full', function () {
      const sampledProbeIndexes = installSampler()
      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_OVERFLOW_INDEX), 0)

      Atomics.store(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX, MAX_SAMPLED_PROBES_PER_PAUSE)

      assert.strictEqual(
        getSampler().makeSampleDecision(7, 'probe-1', 200000n, false),
        false
      )
      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_OVERFLOW_INDEX), 1)
      // The overflow guard is an internal limit without a canonical skip reason, so it's not reported as a skip
      assert.deepStrictEqual(drainGuardrailMetrics(), [])
    })
  })
})

/**
 * Install the runtime sampler for tests.
 */
function installSampler () {
  return new Int32Array(installProbeSampler(guardrailMetrics))
}

/**
 * Drain the guardrail counters recorded by the runtime sampler.
 *
 * @returns {Array<[string, string[], number]>} The non-zero counters as `[metric, tags, count]` tuples.
 */
function drainGuardrailMetrics () {
  /** @type {Array<[string, string[], number]>} */
  const reported = []
  guardrailMetrics.drain((metric, tags, count) => reported.push([metric, tags, count]))
  return reported
}

/**
 * Get the Datadog global test object.
 */
function getDatadogGlobal () {
  return /** @type {Record<symbol, unknown>} */ (
    /** @type {Record<symbol, unknown>} */ (globalThis)[ddTraceSymbol]
  )
}

/**
 * Get the installed runtime sampler.
 */
function getSampler () {
  return /** @type {RuntimeSampler} */ (getDatadogGlobal()[samplerSymbol])
}
