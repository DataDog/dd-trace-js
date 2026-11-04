'use strict'

const assert = require('node:assert/strict')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const expectedExecutions = {
  policy: {
    'protected disabled': 1,
    'protected quarantine': 1,
    'protected both': 2,
    'ordinary quarantine': 1,
    'protected passing': 1,
  },
  'tagged-table': { tagged: 2 },
  sole: { sole: 1 },
  tia: {},
  'protection-only': { sole: 1 },
  removed: { sole: 1 },
  reuse: { first: 1, removed: 3, native: 2 },
  'native-tags': { direct: 2, inherited: 2 },
  'plain-tags': { 'excluded tagged': 1, 'control tagged': 3 },
  'native-suite': { 'native retries': 2 },
  'native-persistent': { direct: 2, inherited: 2, control: 3 },
  collision: { shared: 4 },
  'collision-protection': { shared: 2 },
  concurrent: { excluded: 2, control: 3 },
  'native-condition': { 'native retries': 2 },
  explicit: { 'native retries': 2 },
  atr: { excluded: 1, control: 3, 'protected retry': 2 },
  efd: { excluded: 1, control: 3 },
  atf: { excluded: 1, control: 3 },
}

function prepareExecutionLedger (cwd) {
  const filename = path.join(cwd, 'exclusion-executions.jsonl')
  writeFileSync(filename, '')
  return filename
}

function readExecutions (filename) {
  const counts = {}
  for (const line of readFileSync(filename, 'utf8').split('\n').filter(Boolean)) {
    const name = JSON.parse(line)
    counts[name] = (counts[name] || 0) + 1
  }
  return counts
}

/** @param {boolean} hasFor */
function suiteLocalExpectations (hasFor) {
  const attempts = {
    'local direct': 1,
    'local each 1': 1,
    'local each 2': 1,
    'local concurrent': 1,
    'local conditional': 1,
    'local fixture': 1,
    ...(hasFor ? { 'local for 1': 1, 'local for 2': 1 } : {}),
    'local native': 2,
    'local inherited native': 2,
    'local protected retries': 3,
    'local control': 3,
  }
  return {
    assignments: Object.fromEntries(Object.keys(attempts).filter(name => name !== 'local control').map(name => [
      name, { properties: { disabled: true, quarantined: true, attempt_to_fix: name !== 'local protected retries' } },
    ])),
    executions: {
      'local direct': 1,
      'local each': 2,
      'local concurrent': 1,
      'local conditional': 1,
      'local fixture': 1,
      ...(hasFor ? { 'local for': 2 } : {}),
      'local native': 2,
      'local inherited native': 2,
      'local protected retries': 3,
      'local control': 3,
    },
    /** @param {Array<{ meta: Record<string, string> }>} tests */
    check (tests) {
      assert.strictEqual(tests.length, Object.values(attempts).reduce((sum, count) => sum + count, 0))
      for (const [name, count] of Object.entries(attempts)) {
        const matches = tests.filter(test => test.meta['test.name'] === name)
        assert.strictEqual(matches.length, count, name)
        assert.strictEqual(matches.at(-1).meta['test.final_status'], 'fail', name)
        for (const test of matches) {
          assert.strictEqual(test.meta['test.status'], 'fail', name)
          assert.strictEqual(test.meta['test.test_management.prevent_failure_suppression'],
            name !== 'local control' ? 'true' : undefined, name)
          const noRetry = !['local control', 'local protected retries'].includes(name)
          assert.strictEqual(test.meta['test.test_management.no_auto_retry'], noRetry ? 'true' : undefined, name)
          if (noRetry) {
            assert.ok(!['auto_test_retry', 'early_flake_detection', 'attempt_to_fix']
              .includes(test.meta['test.retry_reason']), name)
          }
        }
      }
    },
  }
}

module.exports = { expectedExecutions, prepareExecutionLedger, readExecutions, suiteLocalExpectations }
