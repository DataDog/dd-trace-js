'use strict'

const { DD_TRACE_SYMBOL, PROBE_SAMPLER_SYMBOL } = require('../probe_sampler_constants')

const SAMPLER_EXPRESSION = `globalThis[Symbol.for(${JSON.stringify(DD_TRACE_SYMBOL)})]?.` +
  `[Symbol.for(${JSON.stringify(PROBE_SAMPLER_SYMBOL)})]`

module.exports = {
  compileBreakpointCondition,
  getRemoveProbeExpression,
}

/**
 * Build the expression that removes a probe from runtime sampler state. Called by the devtools worker and evaluated on
 * the debuggee.
 *
 * @param {string} id - The probe id.
 * @returns {string}
 */
function getRemoveProbeExpression (id) {
  return `${SAMPLER_EXPRESSION}?.remove(${JSON.stringify(id)})`
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

  // NOTE: $dd_sampler is read from the realm-local `globalThis` where it was installed (the main
  // realm). A probe whose code runs in a different V8 realm (e.g. a `vm.createContext` script with a
  // file-path filename) won't see it and will silently never fire. Known limitation: a breakpoint
  // condition has no realm-independent handle to reach, so we degrade rather than crash.
  return `(() => {
    const $dd_sampler = ${SAMPLER_EXPRESSION}
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
