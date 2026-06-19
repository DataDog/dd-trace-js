'use strict'

const { DD_TRACE_SYMBOL, PROBE_SAMPLER_SYMBOL } = require('../probe_sampler_constants')

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

function getSamplerExpression () {
  return `globalThis[Symbol.for(${JSON.stringify(DD_TRACE_SYMBOL)})]?.` +
    `[Symbol.for(${JSON.stringify(PROBE_SAMPLER_SYMBOL)})]`
}
