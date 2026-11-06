'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
require('../setup/mocha')

const { storage } = require('../../../datadog-core')
const { MAX_MESSAGE_LENGTH } = require('../../src/debugger/constants')
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
const legacyStorage = storage('legacy')

/**
 * @typedef {object} RuntimeSampler
 * @property {Function} makeSampleDecision
 * @property {Function} shouldEvaluateCondition
 * @property {Function} conditionError
 * @property {Function} takeConditionError
 * @property {Function} conditionEvaluated
 * @property {Function} evaluationTimedOut
 * @property {Function} remove
 */

const EVALUATION_TIMEOUT_MS = 10
const samplerConfig = {
  dynamicInstrumentation: { DD_DYNAMIC_INSTRUMENTATION_EVALUATION_TIMEOUT_MS: EVALUATION_TIMEOUT_MS },
}

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
      const buffer = installProbeSampler(guardrailMetrics, samplerConfig)
      const sampledProbeIndexes = new Int32Array(buffer)

      assert(buffer instanceof SharedArrayBuffer)
      assert.strictEqual(sampledProbeIndexes.length, SAMPLED_PROBE_INDEXES_START + MAX_SAMPLED_PROBES_PER_PAUSE)
    })

    it('should initialize the shared buffer', function () {
      const installedBuffer = installProbeSampler(guardrailMetrics, samplerConfig)
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
    if ($dd_sampler.shouldEvaluateCondition("probe-1", true)) {
      try {
        $dd_sampled = $dd_sampler.conditionEvaluated(0, "probe-1", ((foo) === (42)) === true,
          200000n, true) || $dd_sampled
      } catch ($dd_error) {
        $dd_sampled = $dd_sampler.conditionError(0, "probe-1", $dd_error) || $dd_sampled
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

    it('should pause for a condition that exceeds the evaluation time budget and skip it afterwards', function () {
      installSampler()
      const sampler = getSampler()
      const probes = [{ id: 'probe-1', samplingIndex: 0, nsBetweenSampling: 0n, condition: 'slow()' }]
      const breakpointCondition = compileBreakpointCondition(probes)
      const evaluate = (elapsedNs) => {
        // eslint-disable-next-line no-new-func
        return new Function('slow', `return ${breakpointCondition}`)(() => {
          now += elapsedNs
          return true
        })
      }

      assert.strictEqual(evaluate(BigInt(EVALUATION_TIMEOUT_MS) * 1_000_000n), true, 'should sample within budget')
      assert.strictEqual(sampler.takeConditionError('probe-1'), undefined)

      assert.strictEqual(evaluate(BigInt(EVALUATION_TIMEOUT_MS) * 1_000_000n + 1n), true, 'should pause for the error')
      assert.strictEqual(
        sampler.takeConditionError('probe-1'),
        'Condition evaluation exceeded its time budget of 10ms (took 10.0ms)'
      )
      assert.strictEqual(evaluate(0n), false, 'should skip the condition while throttled')
      assert.deepStrictEqual(drainGuardrailMetrics(), [
        ['events.skipped', ['event_type:log', 'reason:evaluationTimeout'], 1],
      ])
    })

    it('should report a condition that exceeds the evaluation time budget before throwing as a timeout', function () {
      installSampler()
      const sampler = getSampler()
      const probes = [{ id: 'probe-1', samplingIndex: 0, nsBetweenSampling: 0n, condition: 'slow().bar' }]
      const breakpointCondition = compileBreakpointCondition(probes)
      const evaluate = (elapsedNs) => {
        // eslint-disable-next-line no-new-func
        return new Function('slow', `return ${breakpointCondition}`)(() => {
          now += elapsedNs
        })
      }

      assert.strictEqual(evaluate(BigInt(EVALUATION_TIMEOUT_MS) * 1_000_000n), true, 'should pause for the error')
      assert.strictEqual(
        sampler.takeConditionError('probe-1'),
        "TypeError: Cannot read properties of undefined (reading 'bar')"
      )
      assert.strictEqual(evaluate(0n), false, 'should skip the condition while throttled')
      assert.deepStrictEqual(drainGuardrailMetrics(), [], 'should not count skips caused by a condition error')

      now += CONDITION_ERROR_THROTTLE_NS
      assert.strictEqual(evaluate(BigInt(EVALUATION_TIMEOUT_MS) * 1_000_000n + 1n), true, 'should pause for the error')
      assert.strictEqual(
        sampler.takeConditionError('probe-1'),
        'Condition evaluation exceeded its time budget of 10ms (took 10.0ms)'
      )
      assert.strictEqual(evaluate(0n), false, 'should skip the condition while throttled')
      assert.deepStrictEqual(drainGuardrailMetrics(), [
        ['events.skipped', ['event_type:log', 'reason:evaluationTimeout'], 1],
      ])
    })

    it('should time the conditions of probes at the same location separately', function () {
      const sampledProbeIndexes = installSampler()
      const sampler = getSampler()
      const probes = [
        { id: 'probe-1', samplingIndex: 0, nsBetweenSampling: 0n, condition: 'slow()' },
        { id: 'probe-2', samplingIndex: 1, nsBetweenSampling: 0n, condition: 'slow()' },
      ]
      const breakpointCondition = compileBreakpointCondition(probes)

      // Each condition takes the whole budget, so the second one only stays within it if timed on its own
      // eslint-disable-next-line no-new-func
      assert.strictEqual(new Function('slow', `return ${breakpointCondition}`)(() => {
        now += BigInt(EVALUATION_TIMEOUT_MS) * 1_000_000n
        return true
      }), true)

      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 2)
      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_INDEXES_START), 0)
      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_INDEXES_START + 1), 1)
      assert.strictEqual(sampler.takeConditionError('probe-1'), undefined)
      assert.strictEqual(sampler.takeConditionError('probe-2'), undefined)
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

      now += 199999n

      assert.strictEqual(sampler.makeSampleDecision(7, 'probe-1', 200000n, false), false)
      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 1)
      assert.deepStrictEqual(drainGuardrailMetrics(), [
        ['events.skipped', ['event_type:log', 'reason:rateLimitProbe'], 1],
      ])

      now += 1n

      assert.strictEqual(sampler.makeSampleDecision(7, 'probe-1', 200000n, false), true)
      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 2)

      assert.strictEqual(sampler.makeSampleDecision(7, 'probe-1', 200000n, false), false)
      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 2)
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

    describe('coordinated sampling', function () {
      const oneSecondNs = 1_000_000_000n

      it('should let the first snapshot-producing probe hit in a trace sample all probes in the trace', function () {
        const sampledProbeIndexes = installSampler()
        const sampler = getSampler()
        // Probe 2 just emitted, so it would be rate limited on its own
        assert.strictEqual(sampler.makeSampleDecision(2, 'probe-2', oneSecondNs, true), true)

        inTrace(createTrace(), () => {
          assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', oneSecondNs, true), true)
          assert.strictEqual(sampler.makeSampleDecision(2, 'probe-2', oneSecondNs, true), true)
        })

        assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 3)
        assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_INDEXES_START + 1), 1)
        assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_INDEXES_START + 2), 2)
        assert.deepStrictEqual(drainGuardrailMetrics(), [])
      })

      it('should drop the probes of the whole trace if the first probe hit in it is rate limited', function () {
        const sampledProbeIndexes = installSampler()
        const sampler = getSampler()
        assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', oneSecondNs, true), true)

        inTrace(createTrace(), () => {
          assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', oneSecondNs, true), false)
          // Probe 2 has never emitted, so it would be sampled on its own
          assert.strictEqual(sampler.makeSampleDecision(2, 'probe-2', oneSecondNs, true), false)
        })

        assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 1)
        assert.deepStrictEqual(drainGuardrailMetrics(), [
          ['events.skipped', ['event_type:snapshot', 'reason:rateLimitProbe'], 2],
        ])
      })

      it('should drop the probes of the whole trace if the global snapshot rate limit is reached', function () {
        installSampler()
        const sampler = getSampler()
        for (let i = 0; i < MAX_SNAPSHOTS_PER_SECOND_GLOBALLY; i++) {
          assert.strictEqual(sampler.makeSampleDecision(i, `snapshot-${i}`, 0n, true), true)
        }

        const trace = createTrace()
        inTrace(trace, () => {
          assert.strictEqual(sampler.makeSampleDecision(100, 'probe-1', 0n, true), false)
        })
        now += oneSecondNs + 1n
        inTrace(trace, () => {
          assert.strictEqual(sampler.makeSampleDecision(101, 'probe-2', 0n, true), false)
        })

        assert.deepStrictEqual(drainGuardrailMetrics(), [
          ['events.skipped', ['event_type:snapshot', 'reason:rateLimitGlobal'], 1],
          ['events.skipped', ['event_type:snapshot', 'reason:rateLimitProbe'], 1],
        ])
      })

      it('should emit each probe at most once per sampled trace', function () {
        const sampledProbeIndexes = installSampler()
        const sampler = getSampler()

        inTrace(createTrace(), () => {
          assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', 0n, true), true)
          assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', 0n, true), false)
          assert.strictEqual(sampler.makeSampleDecision(2, 'probe-2', 0n, true), true)
          now += oneSecondNs * 60n
          assert.strictEqual(sampler.makeSampleDecision(2, 'probe-2', 0n, true), false)
        })

        assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 2)
        assert.deepStrictEqual(drainGuardrailMetrics(), [
          ['events.skipped', ['event_type:snapshot', 'reason:rateLimitProbe'], 2],
        ])
      })

      it('should let a modified probe emit again in a sampled trace', function () {
        installSampler()
        const sampler = getSampler()

        inTrace(createTrace(), () => {
          assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', 0n, true), true)
          // A modified probe is re-added with a new sampling index
          sampler.remove('probe-1')
          assert.strictEqual(sampler.makeSampleDecision(2, 'probe-1', 0n, true), true)
        })
      })

      it('should make a separate sampling decision for each trace', function () {
        installSampler()
        const sampler = getSampler()
        const trace1 = createTrace()
        const trace2 = createTrace()

        inTrace(trace1, () => {
          assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', oneSecondNs, true), true)
        })
        inTrace(trace2, () => {
          assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', oneSecondNs, true), false)
          assert.strictEqual(sampler.makeSampleDecision(2, 'probe-2', oneSecondNs, true), false)
        })
        inTrace(trace1, () => {
          assert.strictEqual(sampler.makeSampleDecision(2, 'probe-2', oneSecondNs, true), true)
        })
        now += oneSecondNs
        inTrace(createTrace(), () => {
          assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', oneSecondNs, true), true)
        })
      })

      it('should share the sampling decision between the spans of a trace', function () {
        installSampler()
        const sampler = getSampler()
        const trace = createTrace()

        inTrace(trace, () => {
          assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', 0n, true), true)
        })
        // A different span of the same trace, e.g. a child span
        legacyStorage.run({ span: createSpan(trace) }, () => {
          assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', 0n, true), false)
          assert.strictEqual(sampler.makeSampleDecision(2, 'probe-2', 0n, true), true)
        })
      })

      it('should count snapshots emitted in a sampled trace toward the global rate limit without being limited by it',
        function () {
          const sampledProbeIndexes = installSampler()
          const sampler = getSampler()
          for (let i = 0; i < MAX_SNAPSHOTS_PER_SECOND_GLOBALLY - 2; i++) {
            assert.strictEqual(sampler.makeSampleDecision(i, `snapshot-${i}`, 0n, true), true)
          }

          inTrace(createTrace(), () => {
            assert.strictEqual(sampler.makeSampleDecision(100, 'probe-1', 0n, true), true)
            assert.strictEqual(sampler.makeSampleDecision(101, 'probe-2', 0n, true), true)
            // The global rate limit is reached, but the trace was sampled before it was
            assert.strictEqual(sampler.makeSampleDecision(102, 'probe-3', 0n, true), true)
          })
          inTrace(createTrace(), () => {
            assert.strictEqual(sampler.makeSampleDecision(103, 'probe-4', 0n, true), false)
          })
          assert.strictEqual(sampler.makeSampleDecision(104, 'probe-5', 0n, true), false)

          assert.strictEqual(
            Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX),
            MAX_SNAPSHOTS_PER_SECOND_GLOBALLY + 1
          )
          assert.deepStrictEqual(drainGuardrailMetrics(), [
            ['events.skipped', ['event_type:snapshot', 'reason:rateLimitGlobal'], 2],
          ])

          now += oneSecondNs + 1n
          assert.strictEqual(sampler.makeSampleDecision(104, 'probe-5', 0n, true), true)
        }
      )

      it('should count a snapshot emitted in a sampled trace toward the per-probe rate limit', function () {
        installSampler()
        const sampler = getSampler()

        inTrace(createTrace(), () => {
          assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', oneSecondNs, true), true)
          assert.strictEqual(sampler.makeSampleDecision(2, 'probe-2', oneSecondNs, true), true)
        })
        now += oneSecondNs - 1n
        inTrace(createTrace(), () => {
          assert.strictEqual(sampler.makeSampleDecision(2, 'probe-2', oneSecondNs, true), false)
        })
        now += 1n
        inTrace(createTrace(), () => {
          assert.strictEqual(sampler.makeSampleDecision(2, 'probe-2', oneSecondNs, true), true)
        })
      })

      it('should sample probes that do not produce snapshots independently of the trace', function () {
        installSampler()
        const sampler = getSampler()
        assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', oneSecondNs, true), true)

        inTrace(createTrace(), () => {
          assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', oneSecondNs, true), false)
          assert.strictEqual(sampler.makeSampleDecision(2, 'log-probe', 0n, false), true)
          assert.strictEqual(sampler.makeSampleDecision(2, 'log-probe', 0n, false), true)
        })
        inTrace(createTrace(), () => {
          assert.strictEqual(sampler.makeSampleDecision(3, 'log-probe-2', 0n, false), true)
          // The log probe didn't make a decision for the trace
          assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', oneSecondNs, true), false)
        })
      })

      it('should sample snapshot-producing probes independently without an active span', function () {
        installSampler()
        const sampler = getSampler()

        for (const store of [undefined, { noop: true }, { span: null }, { span: undefined }]) {
          legacyStorage.run(/** @type {Record<string, unknown>} */ (store), () => {
            now += oneSecondNs
            assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', oneSecondNs, true), true)
            assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', oneSecondNs, true), false)
            assert.strictEqual(sampler.makeSampleDecision(2, `probe-2-${now}`, oneSecondNs, true), true)
          })
        }
      })

      it('should sample snapshot-producing probes independently in a trace whose spans have all finished',
        function () {
          installSampler()
          const sampler = getSampler()
          const sampledTrace = createTrace()
          const droppedTrace = createTrace()
          assert.strictEqual(sampler.makeSampleDecision(3, 'probe-3', oneSecondNs, true), true)

          inTrace(sampledTrace, () => {
            assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', oneSecondNs, true), true)
          })
          inTrace(droppedTrace, () => {
            assert.strictEqual(sampler.makeSampleDecision(3, 'probe-3', oneSecondNs, true), false)
          })

          // The span processor empties `started` when it flushes a trace whose spans have all finished
          sampledTrace.started = []
          droppedTrace.started = []
          now += oneSecondNs

          inTrace(sampledTrace, () => {
            assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', oneSecondNs, true), true)
          })
          inTrace(droppedTrace, () => {
            assert.strictEqual(sampler.makeSampleDecision(2, 'probe-2', oneSecondNs, true), true)
          })
        }
      )

      it('should apply the trace decision to probes whose condition matched', function () {
        installSampler()
        const sampler = getSampler()

        inTrace(createTrace(), () => {
          assert.strictEqual(sampler.shouldEvaluateCondition('probe-1', true), true)
          assert.strictEqual(sampler.conditionEvaluated(1, 'probe-1', false, oneSecondNs, true), false)
          assert.strictEqual(sampler.shouldEvaluateCondition('probe-2', true), true)
          assert.strictEqual(sampler.conditionEvaluated(2, 'probe-2', true, oneSecondNs, true), true)
          assert.strictEqual(sampler.shouldEvaluateCondition('probe-1', true), true)
          assert.strictEqual(sampler.conditionEvaluated(1, 'probe-1', true, oneSecondNs, true), true)
          assert.strictEqual(sampler.shouldEvaluateCondition('probe-2', true), true)
          assert.strictEqual(sampler.conditionEvaluated(2, 'probe-2', true, oneSecondNs, true), false)
        })
      })

      it('should not let a condition error make the trace decision', function () {
        const sampledProbeIndexes = installSampler()
        const sampler = getSampler()
        assert.strictEqual(sampler.makeSampleDecision(2, 'probe-2', oneSecondNs, true), true)

        inTrace(createTrace(), () => {
          assert.strictEqual(sampler.shouldEvaluateCondition('probe-1', true), true)
          assert.strictEqual(sampler.conditionError(1, 'probe-1', new Error('boom')), true)
          assert.strictEqual(sampler.makeSampleDecision(2, 'probe-2', oneSecondNs, true), false)
        })

        assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_INDEXES_START + 1), 1 | CONDITION_ERROR_FLAG)
        assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 2)
      })

      it('should leave the trace decision to the next probe if the shared buffer is full', function () {
        const sampledProbeIndexes = installSampler()
        const sampler = getSampler()

        inTrace(createTrace(), () => {
          Atomics.store(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX, MAX_SAMPLED_PROBES_PER_PAUSE)
          assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', oneSecondNs, true), false)

          Atomics.store(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX, 0)
          assert.strictEqual(sampler.makeSampleDecision(2, 'probe-2', oneSecondNs, true), true)
          assert.strictEqual(sampler.makeSampleDecision(1, 'probe-1', oneSecondNs, true), true)

          Atomics.store(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX, MAX_SAMPLED_PROBES_PER_PAUSE)
          assert.strictEqual(sampler.makeSampleDecision(3, 'probe-3', oneSecondNs, true), false)
          Atomics.store(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX, 0)
          assert.strictEqual(sampler.makeSampleDecision(3, 'probe-3', oneSecondNs, true), true)
        })
        assert.deepStrictEqual(drainGuardrailMetrics(), [])
      })
    })

    describe('condition errors', function () {
      const budgetNs = BigInt(EVALUATION_TIMEOUT_MS) * 1_000_000n

      /**
       * Start evaluating a probe's condition the way a compiled breakpoint condition does, then let time pass until the
       * condition returns or throws.
       *
       * @param {RuntimeSampler} sampler - The installed runtime sampler.
       * @param {string} probeId - The probe id.
       * @param {bigint} [elapsedNs] - How long evaluating the condition takes.
       */
      function startCondition (sampler, probeId, elapsedNs = 0n) {
        assert.strictEqual(sampler.shouldEvaluateCondition(probeId), true)
        now += elapsedNs
      }

      it('should evaluate conditions of probes without a recorded error', function () {
        installSampler()

        assert.strictEqual(getSampler().shouldEvaluateCondition('probe-1'), true)
      })

      it('should request a pause flagged as a condition error', function () {
        const sampledProbeIndexes = installSampler()
        const sampler = getSampler()

        startCondition(sampler, 'probe-1')
        assert.strictEqual(sampler.conditionError(7, 'probe-1', new TypeError('boom')), true)
        assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 1)
        assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_INDEXES_START), 7 | CONDITION_ERROR_FLAG)
      })

      it('should hand over the recorded error once', function () {
        installSampler()
        const sampler = getSampler()

        startCondition(sampler, 'probe-1')
        sampler.conditionError(7, 'probe-1', new TypeError('boom'))

        assert.strictEqual(sampler.takeConditionError('probe-1'), 'TypeError: boom')
        assert.strictEqual(sampler.takeConditionError('probe-1'), undefined)
        assert.strictEqual(sampler.takeConditionError('unknown-probe'), undefined)
      })

      it('should describe non-error values thrown by a condition', function () {
        installSampler()
        const sampler = getSampler()

        startCondition(sampler, 'string')
        sampler.conditionError(7, 'string', 'a string')
        assert.strictEqual(sampler.takeConditionError('string'), 'a string')

        startCondition(sampler, 'object')
        sampler.conditionError(7, 'object', { not: 'an error' })
        assert.strictEqual(sampler.takeConditionError('object'), 'Unknown evaluation error')

        startCondition(sampler, 'error-like')
        sampler.conditionError(7, 'error-like', { name: 'CustomError', message: 'boom' })
        assert.strictEqual(sampler.takeConditionError('error-like'), 'CustomError: boom')
      })

      it('should not invoke error accessors or proxy traps when describing a condition error', function () {
        installSampler()
        const sampler = getSampler()

        for (const property of ['name', 'message']) {
          const error = new Error('boom')
          Object.defineProperty(error, property, {
            get () { throw new Error(`${property} getter invoked`) },
          })

          startCondition(sampler, `accessor-${property}`)
          assert.strictEqual(sampler.conditionError(7, `accessor-${property}`, error), true)
          assert.strictEqual(sampler.takeConditionError(`accessor-${property}`), property === 'name' ? 'boom' : 'Error')
        }

        const proxy = new Proxy(new Error('boom'), {
          get () { throw new Error('get trap invoked') },
          getPrototypeOf () { throw new Error('getPrototypeOf trap invoked') },
        })
        startCondition(sampler, 'proxy')
        assert.strictEqual(sampler.conditionError(7, 'proxy', proxy), true)
        assert.strictEqual(sampler.takeConditionError('proxy'), 'Unknown evaluation error')
      })

      it('should preserve condition error descriptions at the message length limit', function () {
        installSampler()
        const sampler = getSampler()
        const error = 'x'.repeat(MAX_MESSAGE_LENGTH)

        startCondition(sampler, 'probe-1')
        sampler.conditionError(7, 'probe-1', error)

        assert.strictEqual(sampler.takeConditionError('probe-1'), error)
      })

      it('should truncate condition error descriptions over the message length limit', function () {
        installSampler()
        const sampler = getSampler()
        const error = 'x'.repeat(MAX_MESSAGE_LENGTH + 1)

        startCondition(sampler, 'probe-1')
        sampler.conditionError(7, 'probe-1', error)

        assert.strictEqual(sampler.takeConditionError('probe-1'), `${error.slice(0, MAX_MESSAGE_LENGTH)}…`)
      })

      it('should truncate formatted Error descriptions over the message length limit', function () {
        installSampler()
        const sampler = getSampler()
        const message = 'x'.repeat(MAX_MESSAGE_LENGTH)

        startCondition(sampler, 'probe-1')
        sampler.conditionError(7, 'probe-1', new Error(message))

        assert.strictEqual(
          sampler.takeConditionError('probe-1'),
          `${`Error: ${message}`.slice(0, MAX_MESSAGE_LENGTH)}…`
        )
      })

      it('should throttle condition evaluation for the throttle window after an error', function () {
        installSampler()
        const sampler = getSampler()

        startCondition(sampler, 'probe-1')
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

        startCondition(sampler, 'probe-1')
        assert.strictEqual(sampler.conditionError(99, 'probe-1', new Error('boom')), true)
        assert.strictEqual(
          Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX),
          MAX_SNAPSHOTS_PER_SECOND_GLOBALLY + 1
        )
      })

      it('should drop the condition error but retain the throttle when the shared buffer is full', function () {
        const sampledProbeIndexes = installSampler()
        const sampler = getSampler()
        Atomics.store(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX, MAX_SAMPLED_PROBES_PER_PAUSE)

        startCondition(sampler, 'probe-1')
        assert.strictEqual(sampler.conditionError(7, 'probe-1', new Error('boom')), false)
        assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_OVERFLOW_INDEX), 1)
        assert.strictEqual(sampler.takeConditionError('probe-1'), undefined)
        assert.strictEqual(sampler.shouldEvaluateCondition('probe-1'), false)
        now += CONDITION_ERROR_THROTTLE_NS - 1n
        assert.strictEqual(sampler.shouldEvaluateCondition('probe-1'), false)
        now += 1n
        assert.strictEqual(sampler.shouldEvaluateCondition('probe-1'), true)
      })

      it('should sample a matching condition evaluated within the time budget', function () {
        const sampledProbeIndexes = installSampler()
        const sampler = getSampler()

        startCondition(sampler, 'probe-1', budgetNs)
        assert.strictEqual(sampler.conditionEvaluated(7, 'probe-1', true, 0n, false), true)
        assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_INDEXES_START), 7)
        startCondition(sampler, 'probe-2', budgetNs)
        assert.strictEqual(sampler.conditionEvaluated(8, 'probe-2', false, 0n, false), false)
        assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 1)
        assert.deepStrictEqual(drainGuardrailMetrics(), [])
      })

      it('should apply the rate limits to matching conditions', function () {
        installSampler()
        const sampler = getSampler()

        startCondition(sampler, 'probe-1')
        assert.strictEqual(sampler.conditionEvaluated(7, 'probe-1', true, 200000n, false), true)
        startCondition(sampler, 'probe-1')
        assert.strictEqual(sampler.conditionEvaluated(7, 'probe-1', true, 200000n, false), false)
        assert.deepStrictEqual(drainGuardrailMetrics(), [
          ['events.skipped', ['event_type:log', 'reason:rateLimitProbe'], 1],
        ])
      })

      it('should report a condition that exceeds the time budget as an error, even if it matched', function () {
        const sampledProbeIndexes = installSampler()
        const sampler = getSampler()

        startCondition(sampler, 'probe-1', budgetNs + 500_000n)
        assert.strictEqual(sampler.conditionEvaluated(7, 'probe-1', true, 0n, true), true)
        assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_INDEXES_START), 7 | CONDITION_ERROR_FLAG)
        assert.strictEqual(
          sampler.takeConditionError('probe-1'),
          'Condition evaluation exceeded its time budget of 10ms (took 10.5ms)'
        )
      })

      it('should count hits skipped because of an exceeded time budget', function () {
        installSampler()
        const sampler = getSampler()

        startCondition(sampler, 'probe-1', budgetNs + 1n)
        sampler.conditionEvaluated(7, 'probe-1', false, 0n, true)
        assert.deepStrictEqual(drainGuardrailMetrics(), [], 'the error result itself is not a skip')

        assert.strictEqual(sampler.shouldEvaluateCondition('probe-1', true), false)
        assert.strictEqual(sampler.shouldEvaluateCondition('probe-1', true), false)
        assert.strictEqual(sampler.makeSampleDecision(7, 'probe-1', 0n, true), false)
        assert.deepStrictEqual(drainGuardrailMetrics(), [
          ['events.skipped', ['event_type:snapshot', 'reason:evaluationTimeout'], 3],
        ])

        now += CONDITION_ERROR_THROTTLE_NS
        assert.strictEqual(sampler.shouldEvaluateCondition('probe-1', true), true)
        assert.deepStrictEqual(drainGuardrailMetrics(), [])
      })

      it('should not count hits skipped because of a condition error', function () {
        installSampler()
        const sampler = getSampler()

        startCondition(sampler, 'probe-1')
        sampler.conditionError(7, 'probe-1', new Error('boom'))
        assert.strictEqual(sampler.shouldEvaluateCondition('probe-1', true), false)
        assert.strictEqual(sampler.makeSampleDecision(7, 'probe-1', 0n, true), false)

        assert.deepStrictEqual(drainGuardrailMetrics(), [])
      })

      it('should report a condition that throws at exactly the time budget as a condition error', function () {
        installSampler()
        const sampler = getSampler()

        startCondition(sampler, 'probe-1', budgetNs)
        assert.strictEqual(sampler.conditionError(7, 'probe-1', new TypeError('boom')), true)
        assert.strictEqual(sampler.takeConditionError('probe-1'), 'TypeError: boom')
        assert.strictEqual(sampler.shouldEvaluateCondition('probe-1', true), false)
        assert.deepStrictEqual(drainGuardrailMetrics(), [])
      })

      it('should report a condition that throws after exceeding the time budget as a timeout', function () {
        const sampledProbeIndexes = installSampler()
        const sampler = getSampler()

        startCondition(sampler, 'probe-1', budgetNs + 1n)
        assert.strictEqual(sampler.conditionError(7, 'probe-1', new TypeError('boom')), true)
        assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_INDEXES_START), 7 | CONDITION_ERROR_FLAG)
        assert.strictEqual(
          sampler.takeConditionError('probe-1'),
          'Condition evaluation exceeded its time budget of 10ms (took 10.0ms)'
        )
        assert.strictEqual(sampler.shouldEvaluateCondition('probe-1', true), false)
        assert.deepStrictEqual(drainGuardrailMetrics(), [
          ['events.skipped', ['event_type:snapshot', 'reason:evaluationTimeout'], 1],
        ])
      })

      it('should throttle a probe whose evaluation timed out in the worker', function () {
        installSampler()
        const sampler = getSampler()

        sampler.evaluationTimedOut('probe-1')

        assert.strictEqual(sampler.makeSampleDecision(7, 'probe-1', 0n, false), false)
        assert.strictEqual(sampler.shouldEvaluateCondition('probe-1', false), false)
        assert.strictEqual(sampler.takeConditionError('probe-1'), undefined, 'the worker already reported the error')
        assert.deepStrictEqual(drainGuardrailMetrics(), [
          ['events.skipped', ['event_type:log', 'reason:evaluationTimeout'], 2],
        ])

        now += CONDITION_ERROR_THROTTLE_NS
        assert.strictEqual(sampler.makeSampleDecision(7, 'probe-1', 0n, false), true)
      })

      it('should keep a condition error recorded by a hit that raced the worker throttling the probe', function () {
        installSampler()
        const sampler = getSampler()

        startCondition(sampler, 'probe-1')
        sampler.conditionError(7, 'probe-1', new TypeError('boom'))
        startCondition(sampler, 'probe-2', budgetNs + 1n)
        sampler.conditionError(8, 'probe-2', new TypeError('boom'))
        sampler.evaluationTimedOut('probe-1')
        sampler.evaluationTimedOut('probe-2')

        assert.strictEqual(sampler.takeConditionError('probe-1'), 'TypeError: boom')
        assert.strictEqual(
          sampler.takeConditionError('probe-2'),
          'Condition evaluation exceeded its time budget of 10ms (took 10.0ms)'
        )
        assert.strictEqual(sampler.shouldEvaluateCondition('probe-1', false), false)
        assert.deepStrictEqual(drainGuardrailMetrics(), [
          ['events.skipped', ['event_type:log', 'reason:evaluationTimeout'], 1],
        ])
      })

      it('should forget the recorded error and throttle when a probe is removed', function () {
        installSampler()
        const sampler = getSampler()

        startCondition(sampler, 'probe-1')
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
  return new Int32Array(installProbeSampler(guardrailMetrics, samplerConfig))
}

/**
 * Create a stand-in for the trace object shared by the spans of a trace that still has unfinished spans.
 *
 * @returns {{ started: object[] }}
 */
function createTrace () {
  return { started: [{}] }
}

/**
 * Create a stand-in for a span of the given trace.
 *
 * @param {{ started: object[] }} trace - The trace the span belongs to.
 */
function createSpan (trace) {
  return { context: () => ({ _trace: trace }) }
}

/**
 * Run a function with a span of the given trace active, the way the tracer activates spans.
 *
 * @param {{ started: object[] }} trace - The trace of the active span.
 * @param {() => void} fn - The function to run.
 */
function inTrace (trace, fn) {
  legacyStorage.run({ span: createSpan(trace) }, fn)
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
