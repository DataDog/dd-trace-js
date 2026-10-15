'use strict'

const assert = require('node:assert/strict')
const { isDeepStrictEqual } = require('node:util')

const { compare } = require('./compare.cjs')

/**
 * Narrow, observable baseline defects; both artifacts must exhibit this exact failure set today.
 * See README.md#legacy-defect-register for ownership, evidence and removal criteria.
 * These are NOT skipped test cases.
 * @param {string} mode
 * @param {string} entry
 * @param {string} scenario
 */
function expectedFailures (mode, entry, scenario) {
  // LEGACY-LAMBDA-001: README.md#legacy-lambda-001
  if (mode === 'normal' && entry === 'npm' && scenario === 'repeat-wrap') {
    return [
      { id: 'lambda.count', actual: 2, expected: 1 },
      { id: 'spans.count', actual: 3, expected: 2 },
      { id: 'metrics.invocations', actual: 2, expected: 1 },
      { id: 'wrapper.identity', actual: false, expected: true },
    ]
  }
  // LEGACY-LAMBDA-002: README.md#legacy-lambda-002
  if (entry.endsWith('esm') && ['timeout-promise', 'timeout-callback', 'timeout-frozen'].includes(scenario)) {
    return [
      { id: 'lambda.count', actual: 0, expected: 1 },
      { id: 'spans.count', actual: 0, expected: 2 },
      { id: 'root.0', actual: false, expected: true },
    ]
  }
  // LEGACY-LAMBDA-003: README.md#legacy-lambda-003
  if (mode === 'normal' && entry.startsWith('layer') && scenario === 'custom-config') {
    return [
      { id: 'trace.extracted.0', actual: false, expected: true },
      { id: 'parent.extracted.0', actual: false, expected: true },
      { id: 'parent.isRoot.0', actual: true, expected: false },
    ]
  }
  return undefined
}

/**
 * @param {object} candidate
 * @param {object} control
 */
function gate (candidate, control) {
  const comparison = compare(candidate, control)
  for (const row of [...candidate.rows, ...control.rows]) {
    assert.ok(Array.isArray(row.failures), 'Missing assertion results')
    assert.equal(row.passed, row.failures.length === 0, 'Contradictory assertion results')
    assert.equal(row.signature, JSON.stringify(row.failures), 'Failure signature does not match assertions')
  }
  const allowed = []
  const unexpected = []
  for (const row of candidate.rows) {
    if (row.passed) continue
    const key = `${row.entry}/${row.scenario}`
    const baseline = control.rows.find(r => r.entry === row.entry && r.scenario === row.scenario)
    const expected = expectedFailures(candidate.mode, row.entry, row.scenario)
    if (expected && !baseline.passed && isDeepStrictEqual(row.failures, expected) &&
      isDeepStrictEqual(baseline.failures, expected)) allowed.push(key)
    else unexpected.push(key)
  }
  return { ...comparison, allowed, unexpected }
}

module.exports = { gate, expectedFailures }
