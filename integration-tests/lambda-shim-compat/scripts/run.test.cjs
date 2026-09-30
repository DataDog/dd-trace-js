'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { select } = require('../assets/fixture/matrix.cjs')
const { compare } = require('./compare.cjs')
const { parseArgs, checkAssets } = require('./run.cjs')

const row = (scenario, passed, signature = 'same error') => ({ entry: 'npm', scenario, passed, signature })
const report = rows => ({
  runtime: 'v22.1.0',
  architecture: 'arm64',
  mode: 'normal',
  shimSha256: 'frozen-shim',
  fixtureSha256: 'same-fixtures',
  rows,
})

test('classifies new failures independently of aggregate pass counts', () => {
  const actual = compare(report([row('new', false), row('fixed', true), row('shared', false),
    row('changed', false, 'different'), row('pass', true)]),
  report([row('new', true), row('fixed', false), row('shared', false), row('changed', false), row('pass', true)]))
  assert.deepEqual(actual.regressions, ['npm/new'])
  assert.deepEqual(actual.improvements, ['npm/fixed'])
  assert.deepEqual(actual.sharedFailures, ['npm/shared'])
  assert.deepEqual(actual.changedFailures, ['npm/changed'])
  assert.deepEqual(actual.sharedPasses, ['npm/pass'])
  assert.equal(actual.candidatePassed, 2)
  assert.equal(actual.controlPassed, 2)
})

test('rejects missing, empty and duplicate cases', () => {
  assert.throws(() => compare(report([]), report([])), /no cases/)
  assert.throws(() => compare(report([row('a', true)]), report([row('b', true)])), /case sets differ/)
  assert.throws(() => compare(report([row('a', true), row('a', true)]), report([row('a', true)])), /Duplicate/)
})

test('rejects mismatched run identities', () => {
  for (const field of ['runtime', 'architecture', 'mode', 'shimSha256', 'fixtureSha256']) {
    const candidate = report([row('a', true)])
    const control = report([row('a', true)])
    control[field] = 'different'
    assert.throws(() => compare(candidate, control), new RegExp(`Mismatched ${field}`))
  }
})

test('requires typed results and failure signatures', () => {
  assert.throws(() => compare(report([row('a', 'true')]), report([row('a', true)])), /Invalid result/)
  assert.throws(() => compare(report([row('a', false, '')]), report([row('a', true)])), /Missing failure/)
})

test('retains the original matrix plus pure-layer and preload controls', () => {
  assert.equal(select('normal').length, 84)
  assert.equal(select('layer-only').length, 20)
  assert.equal(select('preload').length, 5)
  assert.equal(select('normal', 'frozen').length, 10)
  assert.equal(select('normal', 'nonexistent').length, 0)
  assert.ok(select('layer-only').every(r => r.entry.startsWith('layer')))
  assert.ok(select('preload').every(r => r.scenario === 'timeout-promise'))
  assert.throws(() => select('typo'), /Unknown mode/)
})

test('parses independent candidate, output, runtime, filter and control selections', () => {
  const parsed = parseArgs(['--candidate', '/candidate', '--output', '/result', '--runtimes', '18,20',
    '--modes', 'normal', '--control', '5.126.0', '--filter', 'frozen'])
  assert.equal(parsed.candidate, '/candidate')
  assert.deepEqual(parsed.runtimes, ['18', '20'])
  assert.equal(parsed.control, '5.126.0')
  assert.equal(parsed.filter, 'frozen')
  for (const args of [[], ['--candidate'], ['--unknown'], ['--candidate', '/c', '--runtimes', '22,22'],
    ['--candidate', '/c', '--control', 'latest'], ['--candidate', '/c', '--modes', 'typo']]) {
    assert.throws(() => parseArgs(args))
  }
})

test('validates the preserved baseline and rejects a corrupted artifact', () => {
  const baseline = checkAssets()
  assert.equal(baseline.shim.commit, '85fdb2ee2368e4ef03268277e01b9e99119ca4c1')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-compat-integrity-'))
  try {
    fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify(baseline))
    fs.writeFileSync(path.join(dir, baseline.shim.artifact), 'not the baseline')
    assert.throws(() => checkAssets(dir), /checksum mismatch/)
  } finally {
    fs.rmSync(dir, { recursive: true })
  }
})

test('never places generated output inside the candidate checkout', () => {
  const options = parseArgs(['--candidate', '/workspace/dd-trace'])
  assert.ok(options.output.startsWith('/workspace/.lambda-compat-runs/'))
  assert.throws(() => parseArgs(['--candidate', '/workspace/dd-trace', '--output', '/workspace/dd-trace/results']),
    /outside the candidate/)
  assert.throws(() => parseArgs(['--candidate', '/workspace/dd-trace', '--output', '/workspace/dd-trace']),
    /outside the candidate/)
})
