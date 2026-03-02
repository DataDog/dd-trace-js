'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { describe, it } = require('mocha')

const { getFormattedJestTestParameters, getJestSuitesToRun, getEfdRetryCount } = require('../src/util')
describe('getFormattedJestTestParameters', () => {
  it('returns formatted parameters for arrays', () => {
    const result = getFormattedJestTestParameters([[[1, 2], [3, 4]]])
    assert.deepStrictEqual(result, [[1, 2], [3, 4]])
  })

  it('returns formatted parameters for strings', () => {
    const result = getFormattedJestTestParameters([['\n    a    | b    | expected\n    '], 1, 2, 3, 3, 5, 8, 0, 1, 1])
    assert.deepStrictEqual(
      result,
      [{ a: 1, b: 2, expected: 3 }, { a: 3, b: 5, expected: 8 }, { a: 0, b: 1, expected: 1 }]
    )
  })

  it('does not crash for invalid inputs', () => {
    const resultUndefined = getFormattedJestTestParameters(undefined)
    const resultEmptyArray = getFormattedJestTestParameters([])
    const resultObject = getFormattedJestTestParameters({})
    assert.deepStrictEqual(resultEmptyArray, undefined)
    assert.deepStrictEqual(resultUndefined, undefined)
    assert.deepStrictEqual(resultObject, undefined)
  })
})

describe('getJestSuitesToRun', () => {
  it('returns filtered suites', () => {
    const skippableSuites = [
      'src/unit.spec.js',
      'src/integration.spec.js',
    ]
    const tests = [
      { path: '/workspace/dd-trace-js/src/unit.spec.js' },
      { path: '/workspace/dd-trace-js/src/integration.spec.js' },
      { path: '/workspace/dd-trace-js/src/e2e.spec.js' },
    ]
    const rootDir = '/workspace/dd-trace-js'

    const { suitesToRun } = getJestSuitesToRun(skippableSuites, tests, rootDir)
    assert.deepStrictEqual(suitesToRun, [{ path: '/workspace/dd-trace-js/src/e2e.spec.js' }])
  })

  it('returns filtered suites when paths are windows like', () => {
    const skippableSuites = [
      'src/unit.spec.js',
      'src/integration.spec.js',
    ]
    const tests = [
      { path: `C:${path.sep}temp${path.sep}dd-trace-js${path.sep}src${path.sep}unit.spec.js` },
      { path: `C:${path.sep}temp${path.sep}dd-trace-js${path.sep}src${path.sep}integration.spec.js` },
      { path: `C:${path.sep}temp${path.sep}dd-trace-js${path.sep}src${path.sep}e2e.spec.js` },
    ]
    const rootDir = `C:${path.sep}temp${path.sep}dd-trace-js`

    const { suitesToRun } = getJestSuitesToRun(skippableSuites, tests, rootDir)
    assert.deepStrictEqual(suitesToRun, [
      { path: `C:${path.sep}temp${path.sep}dd-trace-js${path.sep}src${path.sep}e2e.spec.js` },
    ])
  })

  it('returns filtered suites when paths are relative', () => {
    const skippableSuites = [
      '../../src/unit.spec.js',
      '../../src/integration.spec.js',
    ]
    const tests = [
      { path: '/workspace/dd-trace-js/src/unit.spec.js' },
      { path: '/workspace/dd-trace-js/src/integration.spec.js' },
      { path: '/workspace/dd-trace-js/src/e2e.spec.js' },
    ]
    const rootDir = '/workspace/dd-trace-js/config/root-config'

    const { suitesToRun } = getJestSuitesToRun(skippableSuites, tests, rootDir)
    assert.deepStrictEqual(suitesToRun, [
      { path: '/workspace/dd-trace-js/src/e2e.spec.js' },
    ])
  })

  it('returns the list of skipped suites', () => {
    const skippableSuites = [
      'src/unit.spec.js',
      'src/integration.spec.js',
      'src/not-in-the-repo-so-will-not-show-up-in-skipped-suites.js',
    ]
    const tests = [
      { path: '/workspace/dd-trace-js/src/unit.spec.js' },
      { path: '/workspace/dd-trace-js/src/integration.spec.js' },
      { path: '/workspace/dd-trace-js/src/e2e.spec.js' },
    ]
    const rootDir = '/workspace/dd-trace-js'

    const { skippedSuites } = getJestSuitesToRun(skippableSuites, tests, rootDir)
    assert.deepStrictEqual(skippedSuites, [
      'src/unit.spec.js',
      'src/integration.spec.js',
    ])
  })

  it('takes unskippable into account', () => {
    const skippableSuites = [
      'fixtures/test-to-skip.js',
      'fixtures/test-unskippable.js',
    ]
    const tests = [
      { path: path.join(__dirname, './fixtures/test-to-run.js') },
      { path: path.join(__dirname, './fixtures/test-to-skip.js') },
      { path: path.join(__dirname, './fixtures/test-unskippable.js') },
    ]
    const rootDir = __dirname

    const { suitesToRun, skippedSuites } = getJestSuitesToRun(skippableSuites, tests, rootDir)
    assert.deepStrictEqual(suitesToRun, [
      {
        path: path.join(__dirname, './fixtures/test-to-run.js'),
      },
      {
        path: path.join(__dirname, './fixtures/test-unskippable.js'),
      },
    ])
    assert.deepStrictEqual(skippedSuites, [
      'fixtures/test-to-skip.js',
    ])
  })

  it('returns hasUnskippableSuites if there is a unskippable suite', () => {
    const skippableSuites = []
    const tests = [
      { path: path.join(__dirname, './fixtures/test-to-run.js'), context: { config: { testEnvironmentOptions: {} } } },
      {
        path: path.join(__dirname, './fixtures/test-unskippable.js'),
        context: { config: { testEnvironmentOptions: {} } },
      },
    ]
    const rootDir = __dirname

    const { hasUnskippableSuites, hasForcedToRunSuites } = getJestSuitesToRun(skippableSuites, tests, rootDir)
    assert.strictEqual(hasUnskippableSuites, true)
    assert.strictEqual(hasForcedToRunSuites, false)
  })

  it('returns hasForcedToRunSuites if there is a forced to run suite', () => {
    const skippableSuites = ['fixtures/test-unskippable.js']
    const tests = [
      { path: path.join(__dirname, './fixtures/test-to-run.js'), context: { config: { testEnvironmentOptions: {} } } },
      {
        path: path.join(__dirname, './fixtures/test-unskippable.js'),
        context: { config: { testEnvironmentOptions: {} } },
      },
    ]
    const rootDir = __dirname

    const { hasUnskippableSuites, hasForcedToRunSuites } = getJestSuitesToRun(skippableSuites, tests, rootDir)
    assert.strictEqual(hasUnskippableSuites, true)
    assert.strictEqual(hasForcedToRunSuites, true)
  })

  it('adds extra `testEnvironmentOptions` if suite is unskippable or forced to run', () => {
    const skippableSuites = ['fixtures/test-unskippable.js']
    // tests share a config object
    const globalConfig = { testEnvironmentOptions: {} }
    const tests = [
      {
        path: path.join(__dirname, './fixtures/test-to-run.js'),
        context: { config: globalConfig },
      },
      {
        path: path.join(__dirname, './fixtures/test-unskippable.js'),
        context: { config: globalConfig },
      },
    ]
    const rootDir = __dirname

    getJestSuitesToRun(skippableSuites, tests, rootDir)
    assert.deepStrictEqual(
      globalConfig.testEnvironmentOptions._ddUnskippable,
      JSON.stringify({ 'fixtures/test-unskippable.js': true })
    )
    assert.deepStrictEqual(
      globalConfig.testEnvironmentOptions._ddForcedToRun,
      JSON.stringify({ 'fixtures/test-unskippable.js': true })
    )
  })
})

describe('getEfdRetryCount', () => {
  const slowTestRetries = { '5s': 10, '10s': 5, '30s': 3, '5m': 2 }

  it('returns 10 retries for a 0 ms test', () => {
    assert.strictEqual(getEfdRetryCount(0, slowTestRetries), 10)
  })

  it('returns 10 retries for a 4999 ms test', () => {
    assert.strictEqual(getEfdRetryCount(4999, slowTestRetries), 10)
  })

  it('returns 5 retries for a 5000 ms test', () => {
    assert.strictEqual(getEfdRetryCount(5000, slowTestRetries), 5)
  })

  it('returns 5 retries for a 9999 ms test', () => {
    assert.strictEqual(getEfdRetryCount(9999, slowTestRetries), 5)
  })

  it('returns 3 retries for a 10000 ms test', () => {
    assert.strictEqual(getEfdRetryCount(10000, slowTestRetries), 3)
  })

  it('returns 2 retries for a 30000 ms test', () => {
    assert.strictEqual(getEfdRetryCount(30000, slowTestRetries), 2)
  })

  it('returns 0 retries for a 300000 ms test (5 min)', () => {
    assert.strictEqual(getEfdRetryCount(300000, slowTestRetries), 0)
  })

  it('returns 0 retries for a test longer than 5 min', () => {
    assert.strictEqual(getEfdRetryCount(300001, slowTestRetries), 0)
  })

  it('falls back to 0 when slow_test_retries is empty', () => {
    assert.strictEqual(getEfdRetryCount(0, {}), 0)
  })
})
