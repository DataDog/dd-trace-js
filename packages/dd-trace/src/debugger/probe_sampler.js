'use strict'

const { MAX_SNAPSHOTS_PER_SECOND_GLOBALLY } = require('./devtools_client/defaults')
const { EVENT_TYPE, SKIPPED_REASON } = require('./guardrail-metrics')
const {
  CONDITION_ERROR_FLAG,
  CONDITION_ERROR_THROTTLE_NS,
  DD_TRACE_SYMBOL,
  MAX_SAMPLED_PROBES_PER_PAUSE,
  PROBE_SAMPLER_SYMBOL,
  SAMPLED_PROBE_COUNT_INDEX,
  SAMPLED_PROBE_INDEXES_START,
  SAMPLED_PROBE_OVERFLOW_INDEX,
} = require('./probe_sampler_constants')

const ddTraceGlobal = /** @type {Record<symbol, SharedArrayBuffer | object | undefined>} */ (
  /** @type {Record<symbol, unknown>} */ (globalThis)[Symbol.for(DD_TRACE_SYMBOL)]
)

/**
 * @typedef {object} ProbeThrottle
 * @property {bigint} untilNs - The probe is skipped at entry until this point in time
 * @property {boolean} timedOut - Whether the throttle was caused by an evaluation exceeding its time budget
 * @property {string | undefined} error - A condition error not yet handed over to the worker
 */

let evaluationTimeoutNs = 0n

module.exports = {
  configureProbeSampler,
  installProbeSampler,
  uninstallProbeSampler,
}

/**
 * Apply the evaluation time budget from the tracer configuration.
 *
 * @param {{ dynamicInstrumentation: { evaluationTimeoutMs: number } }} config - The tracer configuration.
 */
function configureProbeSampler (config) {
  evaluationTimeoutNs = BigInt(config.dynamicInstrumentation.evaluationTimeoutMs) * 1_000_000n
}

/**
 * Install the runtime sampler in the debuggee context.
 *
 * @param {import('./guardrail-metrics').GuardrailMetrics} guardrailMetrics - Counters for skipped probe hits.
 * @param {{ dynamicInstrumentation: { evaluationTimeoutMs: number } }} config - The tracer configuration.
 * @returns {SharedArrayBuffer} The shared sampler buffer to pass to the debugger worker.
 */
function installProbeSampler (guardrailMetrics, config) {
  configureProbeSampler(config)

  const buffer = createProbeSamplerBuffer()

  const lastCaptureNsByProbeId = new Map()
  /**
   * Probes that are skipped at entry because a recent evaluation failed or exceeded its time budget. One error result
   * is reported per throttle window, so the probe stays visible without repeatedly paying for the evaluation.
   *
   * @type {Map<string, ProbeThrottle>}
   */
  const throttleByProbeId = new Map()
  const sampledProbeIndexes = new Int32Array(buffer)
  Atomics.store(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX, 0)
  Atomics.store(sampledProbeIndexes, SAMPLED_PROBE_OVERFLOW_INDEX, 0)

  const oneSecondNs = 1_000_000_000n
  let globalSnapshotSamplingRateWindowStart = 0n
  let snapshotsSampledWithinTheLastSecond = 0

  ddTraceGlobal[Symbol.for(PROBE_SAMPLER_SYMBOL)] = {
    /**
     * The current monotonic time. Exposed so breakpoint conditions can time evaluations without depending on globals
     * of the realm they run in.
     *
     * @returns {bigint}
     */
    now () {
      return process.hrtime.bigint()
    },

    /**
     * Decide if a probe without a condition should be sampled and store sampled probe indexes for the debugger worker.
     *
     * @param {number} probeIndex - The worker-side probe sampling index.
     * @param {string} probeId - The probe id.
     * @param {bigint} nsBetweenSampling - Minimum nanoseconds between samples for this probe.
     * @param {boolean} isSnapshotProducingProbe - Whether this probe counts toward the global snapshot sample limit.
     * @returns {boolean} Whether this probe should make the breakpoint condition pause.
     */
    makeSampleDecision (probeIndex, probeId, nsBetweenSampling, isSnapshotProducingProbe) {
      const now = process.hrtime.bigint()
      if (isThrottled(probeId, now, isSnapshotProducingProbe)) return false
      return sample(probeIndex, probeId, now, nsBetweenSampling, isSnapshotProducingProbe)
    },

    /**
     * Decide if a probe's condition should be evaluated, or skipped because a recent evaluation error throttled it.
     *
     * @param {string} probeId - The probe id.
     * @param {boolean} isSnapshotProducingProbe - Whether this probe produces snapshots.
     * @returns {boolean} Whether the condition should be evaluated on this hit.
     */
    shouldEvaluateCondition (probeId, isSnapshotProducingProbe) {
      return !isThrottled(probeId, process.hrtime.bigint(), isSnapshotProducingProbe)
    },

    /**
     * Decide if a probe should be sampled now that its condition has been evaluated. A condition that exceeded the
     * evaluation time budget is reported like a condition error instead, regardless of its result.
     *
     * @param {number} probeIndex - The worker-side probe sampling index.
     * @param {string} probeId - The probe id.
     * @param {bigint} startNs - The time at which the condition evaluation started.
     * @param {boolean} matched - Whether the condition evaluated to `true`.
     * @param {bigint} nsBetweenSampling - Minimum nanoseconds between samples for this probe.
     * @param {boolean} isSnapshotProducingProbe - Whether this probe counts toward the global snapshot sample limit.
     * @returns {boolean} Whether this probe should make the breakpoint condition pause.
     */
    conditionEvaluated (probeIndex, probeId, startNs, matched, nsBetweenSampling, isSnapshotProducingProbe) {
      const now = process.hrtime.bigint()
      const elapsedNs = now - startNs
      if (elapsedNs > evaluationTimeoutNs) {
        return recordConditionError(probeIndex, probeId, now, describeTimeout(elapsedNs), true)
      }
      return matched === true && sample(probeIndex, probeId, now, nsBetweenSampling, isSnapshotProducingProbe)
    },

    /**
     * Record that a probe's condition threw, throttle the probe, and request a pause so the error can be reported.
     *
     * @param {number} probeIndex - The worker-side probe sampling index.
     * @param {string} probeId - The probe id.
     * @param {unknown} error - The value thrown by the condition.
     * @returns {boolean} Whether this probe should make the breakpoint condition pause.
     */
    conditionError (probeIndex, probeId, error) {
      return recordConditionError(probeIndex, probeId, process.hrtime.bigint(), describeError(error), false)
    },

    /**
     * Hand over the recorded condition error for a probe to the worker. Called by the worker on the paused thread.
     *
     * @param {string} probeId - The probe id.
     * @returns {string | undefined} The error description, if any.
     */
    takeConditionError (probeId) {
      const state = throttleByProbeId.get(probeId)
      if (state === undefined) return
      const { error } = state
      state.error = undefined
      return error
    },

    /**
     * Throttle a probe whose evaluation exceeded its time budget in the worker, e.g. while evaluating its template.
     * Called by the worker after the result has been reported.
     *
     * @param {string} probeId - The probe id.
     */
    evaluationTimedOut (probeId) {
      throttleByProbeId.set(probeId, {
        untilNs: process.hrtime.bigint() + CONDITION_ERROR_THROTTLE_NS,
        timedOut: true,
        error: undefined,
      })
    },

    /**
     * Remove cached sampling state for a probe.
     *
     * @param {string} probeId - The probe id.
     */
    remove (probeId) {
      lastCaptureNsByProbeId.delete(probeId)
      throttleByProbeId.delete(probeId)
    },
  }

  /**
   * Check if a probe is skipped at entry because of a recent evaluation error, recording the skip when the error was
   * an exceeded time budget.
   *
   * @param {string} probeId - The probe id.
   * @param {bigint} now - The current time.
   * @param {boolean} isSnapshotProducingProbe - Whether this probe produces snapshots.
   * @returns {boolean}
   */
  function isThrottled (probeId, now, isSnapshotProducingProbe) {
    const state = throttleByProbeId.get(probeId)
    if (state === undefined || now >= state.untilNs) return false
    if (state.timedOut) {
      guardrailMetrics.eventSkipped(
        SKIPPED_REASON.EVALUATION_TIMEOUT,
        isSnapshotProducingProbe === true ? EVENT_TYPE.SNAPSHOT : EVENT_TYPE.LOG
      )
    }
    return true
  }

  /**
   * Apply the per-probe and global rate limits and store the sampled probe index for the debugger worker.
   *
   * @param {number} probeIndex - The worker-side probe sampling index.
   * @param {string} probeId - The probe id.
   * @param {bigint} now - The current time.
   * @param {bigint} nsBetweenSampling - Minimum nanoseconds between samples for this probe.
   * @param {boolean} isSnapshotProducingProbe - Whether this probe counts toward the global snapshot sample limit.
   * @returns {boolean} Whether this probe should make the breakpoint condition pause.
   */
  function sample (probeIndex, probeId, now, nsBetweenSampling, isSnapshotProducingProbe) {
    const lastCaptureNs = lastCaptureNsByProbeId.get(probeId)
    if (lastCaptureNs !== undefined && now - lastCaptureNs < nsBetweenSampling) {
      guardrailMetrics.eventSkipped(
        SKIPPED_REASON.RATE_LIMIT_PROBE,
        isSnapshotProducingProbe === true ? EVENT_TYPE.SNAPSHOT : EVENT_TYPE.LOG
      )
      return false
    }

    let shouldResetGlobalSnapshotRateWindow = false
    if (isSnapshotProducingProbe === true) {
      if (now - globalSnapshotSamplingRateWindowStart > oneSecondNs) {
        shouldResetGlobalSnapshotRateWindow = true
      } else if (snapshotsSampledWithinTheLastSecond >= MAX_SNAPSHOTS_PER_SECOND_GLOBALLY) {
        guardrailMetrics.eventSkipped(SKIPPED_REASON.RATE_LIMIT_GLOBAL, EVENT_TYPE.SNAPSHOT)
        return false
      }
    }

    if (!storeSampledProbeIndex(probeIndex)) return false

    if (isSnapshotProducingProbe === true) {
      if (shouldResetGlobalSnapshotRateWindow === true) {
        snapshotsSampledWithinTheLastSecond = 1
        globalSnapshotSamplingRateWindowStart = now
      } else {
        snapshotsSampledWithinTheLastSecond++
      }
    }

    lastCaptureNsByProbeId.set(probeId, now)
    return true
  }

  /**
   * Throttle a probe whose condition failed and request a pause so the error can be reported. Error results bypass the
   * per-probe and global rate limits: they are rate limited by the throttle instead, which allows one error result per
   * probe per window.
   *
   * @param {number} probeIndex - The worker-side probe sampling index.
   * @param {string} probeId - The probe id.
   * @param {bigint} now - The current time.
   * @param {string} error - The error description.
   * @param {boolean} timedOut - Whether the error is an exceeded time budget.
   * @returns {boolean} Whether this probe should make the breakpoint condition pause.
   */
  function recordConditionError (probeIndex, probeId, now, error, timedOut) {
    throttleByProbeId.set(probeId, { untilNs: now + CONDITION_ERROR_THROTTLE_NS, timedOut, error })
    return storeSampledProbeIndex(probeIndex | CONDITION_ERROR_FLAG)
  }

  /**
   * Hand a sampled probe index over to the worker for the upcoming pause.
   *
   * @param {number} value - The probe sampling index, possibly with flags set.
   * @returns {boolean} `false` if the shared buffer is full and the probe must be skipped.
   */
  function storeSampledProbeIndex (value) {
    const sampledProbeCount = Atomics.add(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX, 1)
    if (sampledProbeCount >= MAX_SAMPLED_PROBES_PER_PAUSE) {
      Atomics.store(sampledProbeIndexes, SAMPLED_PROBE_OVERFLOW_INDEX, 1)
      return false
    }
    Atomics.store(sampledProbeIndexes, SAMPLED_PROBE_INDEXES_START + sampledProbeCount, value)
    return true
  }

  return buffer
}

/**
 * Remove the runtime sampler from the debuggee context.
 */
function uninstallProbeSampler () {
  delete ddTraceGlobal[Symbol.for(PROBE_SAMPLER_SYMBOL)]
}

/**
 * Describe a value thrown by a probe condition the way the template evaluation does, without touching the value if it's
 * not an error, since conditions can throw anything.
 *
 * @param {unknown} error - The thrown value.
 * @returns {string}
 */
function describeError (error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return typeof error === 'string' ? error : 'Unknown evaluation error'
}

/**
 * Describe a condition evaluation that exceeded its time budget.
 *
 * @param {bigint} elapsedNs - The time the evaluation took.
 * @returns {string}
 */
function describeTimeout (elapsedNs) {
  return `Condition evaluation exceeded its time budget of ${evaluationTimeoutNs / 1_000_000n}ms ` +
    `(took ${(Number(elapsedNs) / 1_000_000).toFixed(1)}ms)`
}

/**
 * Create the shared buffer used to hand sampled probe indexes from breakpoint conditions to the debugger worker.
 *
 * @returns {SharedArrayBuffer}
 */
function createProbeSamplerBuffer () {
  return new SharedArrayBuffer(
    (SAMPLED_PROBE_INDEXES_START + MAX_SAMPLED_PROBES_PER_PAUSE) * Int32Array.BYTES_PER_ELEMENT
  )
}
