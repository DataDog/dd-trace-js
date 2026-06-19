'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
require('../../setup/mocha')

const {
  compileBreakpointCondition,
  createProbeSamplerBuffer,
  getInstallSamplerExpression,
  getRemoveProbeExpression,
  MAX_SAMPLED_PROBES_PER_PAUSE,
  SAMPLED_PROBE_COUNT_INDEX,
  SAMPLED_PROBE_INDEXES_START,
  SAMPLED_PROBE_OVERFLOW_INDEX,
  setProbeSamplerBuffer,
} = require('../../../src/debugger/devtools_client/probe_sampler')
const { MAX_SNAPSHOTS_PER_SECOND_GLOBALLY } = require('../../../src/debugger/devtools_client/defaults')

const ddTraceSymbol = Symbol.for('dd-trace')
const samplerSymbol = Symbol.for('dd-trace.debugger.probeSampler')
const samplerBufferSymbol = Symbol.for('dd-trace.debugger.probeSamplerBuffer')

describe('probe sampler', function () {
  /** @type {typeof process.hrtime.bigint} */
  let originalHrtimeBigint
  /** @type {bigint} */
  let now

  beforeEach(function () {
    delete getDatadogGlobal()[samplerSymbol]
    delete getDatadogGlobal()[samplerBufferSymbol]
    originalHrtimeBigint = process.hrtime.bigint
    now = 1_000_000_000n
    process.hrtime.bigint = () => now
  })

  afterEach(function () {
    process.hrtime.bigint = originalHrtimeBigint
    delete getDatadogGlobal()[samplerSymbol]
    delete getDatadogGlobal()[samplerBufferSymbol]
  })

  describe('shared buffer', function () {
    it('should create a shared buffer with the expected layout', function () {
      const buffer = createProbeSamplerBuffer()
      const sampledProbeIndexes = new Int32Array(buffer)

      assert(buffer instanceof SharedArrayBuffer)
      assert.strictEqual(sampledProbeIndexes.length, SAMPLED_PROBE_INDEXES_START + MAX_SAMPLED_PROBES_PER_PAUSE)
    })

    it('should expose and initialize the shared buffer', function () {
      const buffer = createProbeSamplerBuffer()
      const sampledProbeIndexes = new Int32Array(buffer)
      Atomics.store(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX, 42)
      Atomics.store(sampledProbeIndexes, SAMPLED_PROBE_OVERFLOW_INDEX, 1)

      setProbeSamplerBuffer(buffer)

      assert.strictEqual(getDatadogGlobal()[samplerBufferSymbol], buffer)
      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 0)
      assert.strictEqual(Atomics.load(sampledProbeIndexes, SAMPLED_PROBE_OVERFLOW_INDEX), 0)
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
    try {
      if (((foo) === (42)) === true) {
        $dd_sampled = $dd_sampler.makeSampleDecision(0, "probe-1", 200000n, true) || $dd_sampled
      }
    } catch {}
    return $dd_sampled
  })()`)
    })

    it('should compile an expression that removes probe sampler state', function () {
      assert.strictEqual(getRemoveProbeExpression('probe-1'),
        'globalThis[Symbol.for("dd-trace")]?.[Symbol.for("dd-trace.debugger.probeSampler")]?.remove("probe-1")')
    })
  })

  describe('runtime sampler', function () {
    it('should install the runtime sampler when the buffer is present', function () {
      installSampler()

      assert.strictEqual(typeof getSampler().makeSampleDecision, 'function')
      assert.strictEqual(typeof getSampler().remove, 'function')
    })

    it('should reinstall the runtime sampler with the latest shared buffer', function () {
      const firstBuffer = createProbeSamplerBuffer()
      const firstSampledProbeIndexes = installSampler(firstBuffer)

      const secondBuffer = createProbeSamplerBuffer()
      const secondSampledProbeIndexes = installSampler(secondBuffer)

      assert.strictEqual(getSampler().makeSampleDecision(7, 'probe-1', 200000n, false), true)
      assert.strictEqual(Atomics.load(firstSampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 0)
      assert.strictEqual(Atomics.load(secondSampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX), 1)
      assert.strictEqual(Atomics.load(secondSampledProbeIndexes, SAMPLED_PROBE_INDEXES_START), 7)
    })

    it('should skip installation when the buffer is missing', function () {
      // eslint-disable-next-line no-new-func
      new Function(getInstallSamplerExpression())()

      assert.strictEqual(getDatadogGlobal()[samplerSymbol], undefined)
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
    })
  })
})

/**
 * Install the runtime sampler expression for tests.
 *
 * @param {SharedArrayBuffer} [buffer] - The shared sampler buffer.
 * @returns {Int32Array}
 */
function installSampler (buffer = createProbeSamplerBuffer()) {
  setProbeSamplerBuffer(buffer)
  // eslint-disable-next-line no-new-func
  new Function(getInstallSamplerExpression())()
  return new Int32Array(buffer)
}

/**
 * Get the Datadog global test object.
 *
 * @returns {Record<symbol, unknown>}
 */
function getDatadogGlobal () {
  return /** @type {Record<symbol, unknown>} */ (
    /** @type {Record<symbol, unknown>} */ (globalThis)[ddTraceSymbol]
  )
}

/**
 * Get the installed runtime sampler.
 *
 * @returns {{ makeSampleDecision: Function, remove: Function }}
 */
function getSampler () {
  return /** @type {{ makeSampleDecision: Function, remove: Function }} */ (getDatadogGlobal()[samplerSymbol])
}
