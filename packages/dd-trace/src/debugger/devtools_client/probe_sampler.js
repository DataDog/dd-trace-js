'use strict'

const { MAX_SNAPSHOTS_PER_SECOND_GLOBALLY } = require('./defaults')

const DD_TRACE_SYMBOL = 'dd-trace'
const PROBE_SAMPLER_SYMBOL = 'dd-trace.debugger.probeSampler'
const PROBE_SAMPLER_BUFFER_SYMBOL = 'dd-trace.debugger.probeSamplerBuffer'

// Shared buffer layout. These constants are used by both the main debugger bootstrap and the devtools worker.
const MAX_SAMPLED_PROBES_PER_PAUSE = 256
const SAMPLED_PROBE_COUNT_INDEX = 0
const SAMPLED_PROBE_OVERFLOW_INDEX = 1
const SAMPLED_PROBE_INDEXES_START = 2

module.exports = {
  compileBreakpointCondition,
  createProbeSamplerBuffer,
  getInstallSamplerExpression,
  getRemoveProbeExpression,
  MAX_SAMPLED_PROBES_PER_PAUSE,
  SAMPLED_PROBE_COUNT_INDEX,
  SAMPLED_PROBE_INDEXES_START,
  SAMPLED_PROBE_OVERFLOW_INDEX,
  setProbeSamplerBuffer,
}

function getSamplerExpression () {
  return `globalThis[Symbol.for(${JSON.stringify(DD_TRACE_SYMBOL)})]?.` +
    `[Symbol.for(${JSON.stringify(PROBE_SAMPLER_SYMBOL)})]`
}

// Main-thread setup helpers.

/**
 * Create the shared buffer used to hand sampled probe indexes from breakpoint conditions to the debugger worker. Called
 * by the main debugger bootstrap before the worker starts.
 *
 * @returns {SharedArrayBuffer}
 */
function createProbeSamplerBuffer () {
  return new SharedArrayBuffer(
    (SAMPLED_PROBE_INDEXES_START + MAX_SAMPLED_PROBES_PER_PAUSE) * Int32Array.BYTES_PER_ELEMENT
  )
}

/**
 * Expose the shared sampler buffer to breakpoint condition expressions in the debuggee context. Called by the main
 * debugger bootstrap.
 *
 * @param {SharedArrayBuffer} buffer - The shared sampler buffer.
 */
function setProbeSamplerBuffer (buffer) {
  const ddTrace = /** @type {Record<symbol, SharedArrayBuffer>} */ (
    /** @type {Record<symbol, unknown>} */ (globalThis)[Symbol.for(DD_TRACE_SYMBOL)]
  )
  ddTrace[Symbol.for(PROBE_SAMPLER_BUFFER_SYMBOL)] = buffer
  const sampledProbeIndexes = new Int32Array(buffer)
  Atomics.store(sampledProbeIndexes, SAMPLED_PROBE_COUNT_INDEX, 0)
  Atomics.store(sampledProbeIndexes, SAMPLED_PROBE_OVERFLOW_INDEX, 0)
}

// Worker-side generated expression helpers.

/**
 * Build the expression that installs the runtime sampler in the debuggee context. Called by the devtools worker and
 * evaluated on the debuggee.
 *
 * @returns {string}
 */
function getInstallSamplerExpression () {
  return `(() => {
    const ddTrace = globalThis[Symbol.for(${JSON.stringify(DD_TRACE_SYMBOL)})]
    const probeSamplerSymbol = Symbol.for(${JSON.stringify(PROBE_SAMPLER_SYMBOL)})
    const probeSamplerBufferSymbol = Symbol.for(${JSON.stringify(PROBE_SAMPLER_BUFFER_SYMBOL)})
    if (ddTrace[probeSamplerBufferSymbol] === undefined) return

    const lastCaptureNsByProbeId = new Map()
    const sampledProbeIndexes = new Int32Array(ddTrace[probeSamplerBufferSymbol])
    const oneSecondNs = 1_000_000_000n
    let globalSnapshotSamplingRateWindowStart = 0n
    let snapshotsSampledWithinTheLastSecond = 0

    ddTrace[probeSamplerSymbol] = {
      makeSampleDecision (probeIndex, probeId, nsBetweenSampling, isSnapshotProducingProbe) {
        const now = globalThis.process.hrtime.bigint()
        const lastCaptureNs = lastCaptureNsByProbeId.get(probeId)
        if (lastCaptureNs !== undefined && now - lastCaptureNs < nsBetweenSampling) return false

        let shouldResetGlobalSnapshotRateWindow = false
        if (isSnapshotProducingProbe === true) {
          if (now - globalSnapshotSamplingRateWindowStart > oneSecondNs) {
            shouldResetGlobalSnapshotRateWindow = true
          } else if (snapshotsSampledWithinTheLastSecond >= ${MAX_SNAPSHOTS_PER_SECOND_GLOBALLY}) {
            return false
          }
        }

        const sampledProbeCount = Atomics.add(sampledProbeIndexes, ${SAMPLED_PROBE_COUNT_INDEX}, 1)
        if (sampledProbeCount >= ${MAX_SAMPLED_PROBES_PER_PAUSE}) {
          Atomics.store(sampledProbeIndexes, ${SAMPLED_PROBE_OVERFLOW_INDEX}, 1)
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
        Atomics.store(sampledProbeIndexes, ${SAMPLED_PROBE_INDEXES_START} + sampledProbeCount, probeIndex)
        return true
      },

      remove (probeId) {
        lastCaptureNsByProbeId.delete(probeId)
      }
    }
  })()`
}

/**
 * Build the expression that removes a probe from runtime sampler state. Called by the devtools worker and evaluated on
 * the debuggee.
 *
 * @param {string} id - The probe id.
 * @returns {string}
 */
function getRemoveProbeExpression (id) {
  return `${getSamplerExpression()}?.remove(${JSON.stringify(id)})`
}

/**
 * Build a Chrome DevTools breakpoint condition that samples all matching probes at a location. Called by the devtools
 * worker.
 *
 * @param {{
 *   id: string,
 *   samplingIndex: number,
 *   nsBetweenSampling: bigint,
 *   condition?: string,
 *   captureSnapshot?: boolean,
 *   compiledCaptureExpressions?: object[]
 * }[]} probes - The probes at the breakpoint location.
 * @returns {string}
 */
function compileBreakpointCondition (probes) {
  const probeConditions = []
  for (const probe of probes) {
    probeConditions.push(compileProbeCondition(probe))
  }

  return `(() => {
    const $dd_sampler = ${getSamplerExpression()}
    if ($dd_sampler === undefined) return false
    let $dd_sampled = false
    ${probeConditions.join('\n    ')}
    return $dd_sampled
  })()`
}

/**
 * Build the condition fragment for a single probe. Called by the devtools worker while building breakpoint conditions.
 *
 * @param {{
 *   id: string,
 *   samplingIndex: number,
 *   nsBetweenSampling: bigint,
 *   condition?: string,
 *   captureSnapshot?: boolean,
 *   compiledCaptureExpressions?: object[]
 * }} probe - The probe to sample.
 * @returns {string}
 */
function compileProbeCondition (probe) {
  const sample = `$dd_sampler.makeSampleDecision(${probe.samplingIndex}, ${JSON.stringify(probe.id)}, ` +
    `${probe.nsBetweenSampling}n, ${probe.captureSnapshot === true || probe.compiledCaptureExpressions !== undefined})`

  if (probe.condition === undefined) {
    return `$dd_sampled = ${sample} || $dd_sampled`
  }

  return `try {
      if ((${probe.condition}) === true) {
        $dd_sampled = ${sample} || $dd_sampled
      }
    } catch {}`
}
