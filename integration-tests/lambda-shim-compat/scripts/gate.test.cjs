'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { inspect } = require('../assets/fixture/assertions.cjs')
const { select } = require('../assets/fixture/matrix.cjs')
const { gate, expectedFailures } = require('./gate.cjs')
const { plan } = require('./plan.cjs')
const { parseArgs } = require('./run.cjs')

const row = (failures, entry = 'layer-esm', scenario = 'timeout-promise') =>
  ({ entry, scenario, passed: failures.length === 0, failures, signature: JSON.stringify(failures) })
const report = rows => ({
  runtime: 'v22.1.0',
  architecture: 'arm64',
  mode: 'normal',
  shimSha256: 'frozen-shim',
  fixtureSha256: 'same-fixtures',
  rows,
})

test('every exception in the full matrix belongs to the tracked legacy defect inventory', () => {
  // Keep these IDs aligned with README.md#legacy-defect-register. A fix removes its entries,
  // not its behavioral probes; adding cases to a broad gate predicate needs explicit review.
  const tracked = {
    'LEGACY-LAMBDA-001': ['normal/npm/repeat-wrap'],
    'LEGACY-LAMBDA-002': [
      'normal/redirect-esm/timeout-promise',
      'normal/redirect-esm/timeout-callback',
      'normal/redirect-esm/timeout-frozen',
      'normal/layer-esm/timeout-promise',
      'normal/layer-esm/timeout-callback',
      'normal/layer-esm/timeout-frozen',
      'layer-only/layer-esm/timeout-promise',
      'layer-only/layer-esm/timeout-callback',
      'layer-only/layer-esm/timeout-frozen',
      'preload/redirect-esm/timeout-promise',
      'preload/layer-esm/timeout-promise',
    ],
    'LEGACY-LAMBDA-003': ['normal/layer-cjs/custom-config', 'normal/layer-esm/custom-config'],
  }
  const actual = ['normal', 'layer-only', 'preload'].flatMap(mode => select(mode)
    .filter(({ entry, scenario }) => expectedFailures(mode, entry, scenario))
    .map(({ entry, scenario }) => `${mode}/${entry}/${scenario}`))
  const expected = Object.values(tracked).flat()
  assert.equal(new Set(expected).size, expected.length, 'A case must belong to exactly one tracked defect')
  assert.deepEqual(actual.sort(), expected.sort())
})

test('only exact, freshly reproduced baseline failures are eligible', () => {
  const expected = expectedFailures('normal', 'layer-esm', 'timeout-promise')
  assert.equal(gate(report([row(expected)]), report([row(expected)])).allowed.length, 1)
  assert.equal(gate(report([row(expected)]), report([row([])])).unexpected.length, 1)
  const changed = [...expected, { id: 'metrics.custom', actual: 0, expected: 1 }]
  assert.equal(gate(report([row(changed)]), report([row(expected)])).unexpected.length, 1)
  assert.equal(gate(report([row(changed)]), report([row(changed)])).unexpected.length, 1)
  assert.equal(gate(report([row(expected)]), report([row(changed)])).unexpected.length, 1)
  assert.equal(gate(report([row([])]), report([row(expected)])).unexpected.length, 0)
})

test('duplicate Lambda spans can never use the missing-span exception', () => {
  const failures = [{ id: 'lambda.count', actual: 2, expected: 1 }]
  assert.equal(gate(report([row(failures)]), report([row(failures)])).unexpected.length, 1)
})

test('npm re-wrapping accepts only the exact reviewed defect, not changed duplication', () => {
  const expected = expectedFailures('normal', 'npm', 'repeat-wrap')
  const sample = row(expected, 'npm', 'repeat-wrap')
  assert.equal(gate(report([sample]), report([sample])).allowed.length, 1)
  for (const extra of [
    { id: 'repeat.topology', actual: false, expected: true },
    { id: 'lambda.owners', actual: false, expected: true },
  ]) {
    const changed = row([...expected, extra], 'npm', 'repeat-wrap')
    assert.equal(gate(report([changed]), report([sample])).unexpected.length, 1)
  }
})

test('contradictory reports fail closed', () => {
  const sample = row([])
  assert.throws(() => gate(report([{ ...sample, failures: [{}] }]), report([sample])), /Contradictory/)
  assert.throws(() => gate(report([{ ...sample, signature: 'wrong' }]), report([sample])), /signature/)
})

test('a matching unknown failure is still red and a known case in another entry is red', () => {
  const failure = expectedFailures('normal', 'layer-esm', 'timeout-promise')
  for (const sample of [row(failure, 'npm'), row([{ id: 'unknown', actual: 0, expected: 1 }])]) {
    assert.equal(gate(report([sample]), report([sample])).unexpected.length, 1)
  }
  assert.equal(expectedFailures('layer-only', 'layer-cjs', 'custom-config'), undefined)
})

test('all supported release lines derive their runtime matrix from unmodified package metadata', () => {
  for (const major of [5, 6, 7]) {
    const pkg = { version: `${major}.0.0`, engines: { node: major === 5 ? '>=18' : '>=22' }, nodeMaxMajor: 27 }
    assert.deepEqual(plan(pkg).node, major === 5 ? ['18', '20', '22', '24', '26'] : ['22', '24', '26'])
    assert.equal(pkg.engines.node, major === 5 ? '>=18' : '>=22')
  }
  assert.deepEqual(plan({ version: '6.0.0', engines: { node: '>=24' }, nodeMaxMajor: 25 }).node, ['24'])
  assert.deepEqual(plan({ version: '6.0.0', engines: { node: '>=22.12.0' }, nodeMaxMajor: 27 }).node,
    ['22', '24', '26'])
  assert.throws(() => plan({ version: '8.0.0' }), /reviewed/)
  assert.throws(() => plan({ version: '6.0.0', engines: { node: '>=28' }, nodeMaxMajor: 28 }), /No compatible/)
})

for (const major of [5, 6, 7]) {
  test(`v${major} treats nodeMaxMajor as the first unsupported runtime`, () => {
    const pkg = { version: `${major}.0.0`, engines: { node: major === 5 ? '>=18' : '>=22' }, nodeMaxMajor: 26 }
    const belowBoundary = major === 5 ? ['18', '20', '22', '24'] : ['22', '24']
    assert.deepEqual(plan(pkg).node, belowBoundary)
    assert.deepEqual(plan({ ...pkg, nodeMaxMajor: 27 }).node, [...belowBoundary, '26'])
    assert.throws(() => plan({ ...pkg, engines: { node: '>=26' } }), /No compatible Lambda runtimes/)
  })
}

test('CI mode refuses reduced coverage or an unreviewed control', () => {
  for (const args of [['--filter', 'promise'], ['--modes', 'normal'], ['--control', '5.126.0']]) {
    assert.throws(() => parseArgs(['--candidate', '/candidate', '--ci', ...args]), /CI gate/)
  }
  assert.equal(parseArgs(['--candidate', '/candidate', '--ci']).ci, true)
})

test('independent assertions survive a missing root and report additional metric failures', () => {
  const failures = inspect({ status: 0 }, [], 'timeout-promise', { version: '6.0.0', shimVersion: '12.143.0' })
  for (const id of ['lambda.count', 'metrics.custom', 'results.count', 'identity.count', 'active.0']) {
    assert.ok(failures.some(failure => failure.id === id), id)
  }
})
