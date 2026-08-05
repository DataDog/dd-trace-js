'use strict'

const { MAX_SNAPSHOTS_PER_SECOND_GLOBALLY } = require('./devtools_client/defaults')
const {
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
 * @returns {SharedArrayBuffer} The shared sampler buffer to pass to the debugger worker.
 */
function installProbeSampler () {
  const buffer = createProbeSamplerBuffer()

  const lastCaptureNsByProbeId = new Map()
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
     * @returns {boolean} Whether this probe should make the breakpoint condition pause.
     */
    makeSampleDecision (probeIndex, probeId, nsBetweenSampling, isSnapshotProducingProbe) {
      const now = process.hrtime.bigint()
      const lastCaptureNs = lastCaptureNsByProbeId.get(probeId)
      if (lastCaptureNs !== undefined && now - lastCaptureNs < nsBetweenSampling) return false

      let shouldResetGlobalSnapshotRateWindow = false
      if (isSnapshotProducingProbe === true) {
        if (now - globalSnapshotSamplingRateWindowStart > oneSecondNs) {
          shouldResetGlobalSnapshotRateWindow = true
        } else if (snapshotsSampledWithinTheLastSecond >= MAX_SNAPSHOTS_PER_SECOND_GLOBALLY) {
          return false
        }
      }

      const sampledProbeCount = Atomics.add(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX, 1)
      if (sampledProbeCount >= MAX_SAMPLED_PROBES_PER_PAUSE) {
        Atomics.store(sampledProbeIndexes, SAMPLED_PROBE_OVERFLOW_INDEX, 1)
        return false
      }

      if (isSnapshotProducingProbe === true) {
        if (shouldResetGlobalSnapshotRateWindow === true) {
          snapshotsSampledWithinTheLastSecond = 1
          globalSnapshotSamplingRateWindowStart = now
        } else {
          snapshotsSampledWithinTheLastSecond++
        }
      }

      lastCaptureNsByProbeId.set(probeId, now)
      Atomics.store(sampledProbeIndexes, SAMPLED_PROBE_INDEXES_START + sampledProbeCount, probeIndex)
      return true
    },

    /**
     * Remove cached sampling state for a probe.
     *
     * @param {string} probeId - The probe id.
     */
    remove (probeId) {
      lastCaptureNsByProbeId.delete(probeId)
    },
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
 * Create the shared buffer used to hand sampled probe indexes from breakpoint conditions to the debugger worker.
 *
 * @returns {SharedArrayBuffer}
 */
function createProbeSamplerBuffer () {
  return new SharedArrayBuffer(
    (SAMPLED_PROBE_INDEXES_START + MAX_SAMPLED_PROBES_PER_PAUSE) * Int32Array.BYTES_PER_ELEMENT
  )
}
