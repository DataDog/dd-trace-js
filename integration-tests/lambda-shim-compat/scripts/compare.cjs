'use strict'

const assert = require('node:assert/strict')

/** @param {{rows: object[]}} report */
function index (report) {
  assert.ok(Array.isArray(report.rows) && report.rows.length, 'Report has no cases')
  const rows = new Map()
  for (const row of report.rows) {
    const key = `${row.entry}/${row.scenario}`
    assert.equal(typeof row.passed, 'boolean', `Invalid result: ${key}`)
    assert.ok(!rows.has(key), `Duplicate case: ${key}`)
    assert.ok(row.passed || row.signature, `Missing failure signature: ${key}`)
    rows.set(key, row)
  }
  return rows
}

/**
 * @param {{rows: object[], runtime: string, architecture: string, mode: string}} candidate
 * @param {{rows: object[], runtime: string, architecture: string, mode: string}} control
 */
function compare (candidate, control) {
  for (const field of ['runtime', 'architecture', 'mode', 'shimSha256', 'fixtureSha256']) {
    assert.ok(candidate[field], `Missing ${field}`)
    assert.equal(candidate[field], control[field], `Mismatched ${field}`)
  }
  const c = index(candidate)
  const b = index(control)
  assert.deepEqual([...c.keys()].sort(), [...b.keys()].sort(), 'Candidate/control case sets differ')
  const result = { regressions: [], improvements: [], sharedFailures: [], changedFailures: [], sharedPasses: [] }
  for (const [key, row] of c) {
    const baseline = b.get(key)
    const category = row.passed
      ? (baseline.passed ? 'sharedPasses' : 'improvements')
      : baseline.passed
        ? 'regressions'
        : row.signature === baseline.signature ? 'sharedFailures' : 'changedFailures'
    result[category].push(key)
  }
  result.total = c.size
  result.candidatePassed = [...c.values()].filter(r => r.passed).length
  result.controlPassed = [...b.values()].filter(r => r.passed).length
  return result
}

module.exports = { compare }
