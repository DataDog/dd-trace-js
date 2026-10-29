'use strict'

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

module.exports = { expectedExecutions, prepareExecutionLedger, readExecutions }
