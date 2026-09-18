'use strict'

const { types } = require('node:util')

const { MAX_SNAPSHOTS_PER_SECOND_GLOBALLY } = require('./devtools_client/defaults')
const { MAX_MESSAGE_LENGTH } = require('./constants')
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

module.exports = {
  installProbeSampler,
  uninstallProbeSampler,
}

/**
 * Install the runtime sampler in the debuggee context.
 *
 * @param {import('./guardrail-metrics').GuardrailMetrics} guardrailMetrics - Counters for skipped probe hits.
 * @returns {SharedArrayBuffer} The shared sampler buffer to pass to the debugger worker.
 */
function installProbeSampler (guardrailMetrics) {
  const buffer = createProbeSamplerBuffer()

  const lastCaptureNsByProbeId = new Map()
  /**
   * Probes whose condition recently failed to evaluate, keyed by probe id. The error is kept until the worker picks it
   * up for the error result.
   *
   * @type {Map<string, { throttledUntilNs: bigint, error: string | undefined }>}
   */
  const conditionErrorByProbeId = new Map()
  const sampledProbeIndexes = new Int32Array(buffer)
  Atomics.store(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX, 0)
  Atomics.store(sampledProbeIndexes, SAMPLED_PROBE_OVERFLOW_INDEX, 0)

  const oneSecondNs = 1_000_000_000n
  let globalSnapshotSamplingRateWindowStart = 0n
  let snapshotsSampledWithinTheLastSecond = 0

  ddTraceGlobal[Symbol.for(PROBE_SAMPLER_SYMBOL)] = {
    /**
     * Decide if a probe should be sampled and store sampled probe indexes for the debugger worker.
     *
     * @param {number} probeIndex - The worker-side probe sampling index.
     * @param {string} probeId - The probe id.
     * @param {bigint} nsBetweenSampling - Minimum nanoseconds between samples for this probe.
     * @param {boolean} isSnapshotProducingProbe - Whether this probe counts toward the global snapshot sample limit.
     */
    makeSampleDecision (probeIndex, probeId, nsBetweenSampling, isSnapshotProducingProbe) {
      const now = process.hrtime.bigint()
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
    },

    /**
     * Decide if a probe's condition should be evaluated, or skipped because a recent evaluation error throttled it.
     *
     * @param {string} probeId - The probe id.
     */
    shouldEvaluateCondition (probeId) {
      const state = conditionErrorByProbeId.get(probeId)
      return state === undefined || process.hrtime.bigint() >= state.throttledUntilNs
    },

    /**
     * Record that a probe's condition threw, throttle the probe, and request a pause if the error can be reported.
     *
     * Error results bypass the per-probe and global rate limits: they are rate limited by the throttle instead, which
     * allows one error result per probe per window. If the shared buffer is full, the error is dropped but the throttle
     * is retained.
     *
     * @param {number} probeIndex - The worker-side probe sampling index.
     * @param {string} probeId - The probe id.
     * @param {unknown} error - The value thrown by the condition.
     */
    conditionError (probeIndex, probeId, error) {
      const stored = storeSampledProbeIndex(probeIndex | CONDITION_ERROR_FLAG)
      conditionErrorByProbeId.set(probeId, {
        throttledUntilNs: process.hrtime.bigint() + CONDITION_ERROR_THROTTLE_NS,
        error: stored ? describeError(error) : undefined,
      })
      return stored
    },

    /**
     * Hand over the recorded condition error for a probe to the worker. Called by the worker on the paused thread.
     *
     * @param {string} probeId - The probe id.
     * @returns {string | undefined} The error description, if any.
     */
    takeConditionError (probeId) {
      const state = conditionErrorByProbeId.get(probeId)
      if (state === undefined) return
      const { error } = state
      state.error = undefined
      return error
    },

    /**
     * Remove cached sampling state for a probe.
     *
     * @param {string} probeId - The probe id.
     */
    remove (probeId) {
      lastCaptureNsByProbeId.delete(probeId)
      conditionErrorByProbeId.delete(probeId)
    },
  }

  /**
   * Hand a sampled probe index over to the worker for the upcoming pause.
   *
   * @param {number} value - The probe sampling index, possibly with flags set.
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
 * Describe a value thrown by a probe condition without invoking user code. Conditions can throw anything, including
 * errors with accessors and proxies whose traps have side effects.
 *
 * @param {unknown} error - The thrown value.
 */
function describeError (error) {
  if (typeof error === 'string') return truncateErrorDescription(error)
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return 'Unknown evaluation error'
  }

  const name = getErrorStringProperty(error, 'name')
  const message = getErrorStringProperty(error, 'message')
  if (name === undefined) return truncateErrorDescription(message ?? 'Unknown evaluation error')
  if (message === undefined) return truncateErrorDescription(name)

  return truncateErrorDescription(`${name}: ${message}`)
}

/**
 * Bound an error description before retaining or transferring it.
 *
 * @param {string} description - The description to bound.
 */
function truncateErrorDescription (description) {
  return description.length > MAX_MESSAGE_LENGTH
    ? `${description.slice(0, MAX_MESSAGE_LENGTH)}…`
    : description
}

/**
 * Read a string-valued error property without invoking accessors or proxy traps.
 *
 * @param {object} error - The thrown object to inspect.
 * @param {'name' | 'message'} property - The property to find.
 */
function getErrorStringProperty (error, property) {
  while (error !== null) {
    if (types.isProxy(error)) return
    const descriptor = Object.getOwnPropertyDescriptor(error, property)
    if (descriptor !== undefined) return typeof descriptor.value === 'string' ? descriptor.value : undefined
    error = Object.getPrototypeOf(error)
  }
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
