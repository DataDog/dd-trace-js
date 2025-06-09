'use strict'

/**
 * Determines if an OpenTelemetry span is a Vercel AI span
 *
 * @param {import('../../dd-trace/src/opentracing/span') | null} span
 * @returns {Boolean}
 */
function isVercelAISpan (span) {
  return span._name?.startsWith('ai') && span.context()._tags?.['resource.name']?.startsWith('ai')
}

module.exports = {
  isVercelAISpan
}
