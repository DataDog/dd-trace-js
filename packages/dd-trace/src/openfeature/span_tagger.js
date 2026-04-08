'use strict'

const { FF_TAG_PREFIX } = require('./constants/constants')

/**
 * Builds a feature flag tag mapping flag key to variant.
 *
 * @param {string} flagKey - The feature flag key
 * @param {string} [variantKey] - The variant key from the evaluation result
 * @returns {{[key: string]: string}} Tag key-value pair
 */
function buildFeatureFlagTags (flagKey, variantKey) {
  if (variantKey === undefined) return {}
  return { [`${FF_TAG_PREFIX}.${flagKey}`]: variantKey }
}

/**
 * Counts the number of feature flag tags in the trace-level tags.
 *
 * @param {import('../opentracing/span')} span
 * @returns {number}
 */
function countFlagTags (span) {
  const traceTags = span.context()._trace.tags
  const prefix = `${FF_TAG_PREFIX}.`
  let count = 0

  for (const key in traceTags) {
    if (key.startsWith(prefix)) {
      count++
    }
  }

  return count
}

/**
 * Tags the active span and trace with feature flag evaluation metadata.
 * Span-level tags go on the active span via addTags(). Trace-level tags go on
 * _trace.tags, which the formatter automatically applies to the root/chunk span.
 * Skips tagging if the number of flags already on the trace reaches maxFlagTags.
 *
 * @param {import('../tracer')} tracer - Datadog tracer instance
 * @param {object} params
 * @param {string} params.flagKey - The feature flag key
 * @param {string} [params.variantKey] - The variant key from the evaluation result
 * @param {number} [params.maxFlagTags] - Maximum number of flag tags per trace
 */
function tagSpansForEvaluation (tracer, { flagKey, variantKey, maxFlagTags }) {
  const activeSpan = tracer.scope().active()
  if (!activeSpan) return

  if (maxFlagTags !== undefined && countFlagTags(activeSpan) >= maxFlagTags) return

  const tags = buildFeatureFlagTags(flagKey, variantKey)

  activeSpan.addTags(tags)
  Object.assign(activeSpan.context()._trace.tags, tags)
}

module.exports = {
  countFlagTags,
  buildFeatureFlagTags,
  tagSpansForEvaluation,
}
