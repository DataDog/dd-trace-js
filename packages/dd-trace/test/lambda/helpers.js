'use strict'

const assert = require('node:assert/strict')

/**
 * Counts Lambda spans across every captured trace chunk, including unrelated root traces.
 * Call only after invocation completion; never use inside an assertSomeTraces matcher, which
 * can succeed on an earlier payload before the duplicate arrives.
 *
 * @param {object[][]} traces All exported trace chunks for one invocation.
 * @returns {object} The sole Lambda span.
 */
function assertExactlyOneLambdaSpan (traces) {
  const spans = traces.flat().filter(span => span.name === 'aws.lambda')
  assert.strictEqual(spans.length, 1, 'exactly one aws.lambda span across all exported traces')
  return spans[0]
}

module.exports = { assertExactlyOneLambdaSpan }
