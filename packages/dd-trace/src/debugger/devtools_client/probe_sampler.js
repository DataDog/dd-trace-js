'use strict'

const { DD_TRACE_SYMBOL, PROBE_SAMPLER_SYMBOL } = require('../probe_sampler_constants')

const SAMPLER_EXPRESSION = `globalThis[Symbol.for(${JSON.stringify(DD_TRACE_SYMBOL)})]?.` +
  `[Symbol.for(${JSON.stringify(PROBE_SAMPLER_SYMBOL)})]`

module.exports = {
  compileBreakpointCondition,
  getEvaluationTimedOutExpression,
  getRemoveProbeExpression,
  getTakeConditionErrorExpression,
}

/**
 * Build the expression that throttles a probe whose evaluation exceeded its time budget in the worker. Called by the
 * devtools worker and evaluated on the debuggee.
 *
 * @param {string} id - The probe id.
 * @returns {string}
 */
function getEvaluationTimedOutExpression (id) {
  return `${SAMPLER_EXPRESSION}?.evaluationTimedOut(${JSON.stringify(id)})`
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
 * Build the expression that hands over the condition error recorded for a probe. Called by the devtools worker and
 * evaluated on the paused frame of the debuggee.
 *
 * @param {string} id - The probe id.
 * @returns {string}
 */
function getTakeConditionErrorExpression (id) {
  return `${SAMPLER_EXPRESSION}?.takeConditionError(${JSON.stringify(id)})`
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
  const probeConditions = probes.map(compileProbeCondition)

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
  const id = JSON.stringify(probe.id)
  const isSnapshotProducingProbe = probe.captureSnapshot === true || probe.compiledCaptureExpressions !== undefined
  const samplingArgs = `${probe.nsBetweenSampling}n, ${isSnapshotProducingProbe}`

  if (probe.condition === undefined) {
    return `$dd_sampled = $dd_sampler.makeSampleDecision(${probe.samplingIndex}, ${id}, ${samplingArgs}) || $dd_sampled`
  }

  // The condition is timed against the evaluation budget. A condition that throws or exceeds its budget is reported
  // once per throttle window and skipped at probe entry in between.
  return `if ($dd_sampler.shouldEvaluateCondition(${id}, ${isSnapshotProducingProbe})) {
      const $dd_start = $dd_sampler.now()
      try {
        $dd_sampled = $dd_sampler.conditionEvaluated(${probe.samplingIndex}, ${id}, $dd_start,
          (${probe.condition}) === true, ${samplingArgs}) || $dd_sampled
      } catch ($dd_error) {
        $dd_sampled = $dd_sampler.conditionError(${probe.samplingIndex}, ${id}, $dd_error) || $dd_sampled
      }
    }`
}
