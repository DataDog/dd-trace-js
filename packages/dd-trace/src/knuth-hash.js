'use strict'

const UINT64_MODULO = 2n ** 64n

// Knuth's factor for the sampling algorithm shared across Datadog tracers.
const SAMPLING_KNUTH_FACTOR = 1_111_111_111_111_111_111n

/**
 * Hashes the lower 64 bits of a trace ID for deterministic trace sampling.
 *
 * @param {bigint} traceId
 * @returns {bigint}
 */
function knuthHash (traceId) {
  return (traceId * SAMPLING_KNUTH_FACTOR) % UINT64_MODULO
}

module.exports = knuthHash
