'use strict'

const { expect } = require('chai')
const { describe, it } = require('mocha')

const path = require('node:path')

const { getFormattedJestTestParameters, getJestSuitesToRun } = require('../src/util')

describe('getFormattedJestTestParameters', () => {
  it('returns formatted parameters for arrays', () => {
    const result = getFormattedJestTestParameters([[[1, 2], [3, 4]]])
    expect(result).to.eql([[1, 2], [3, 4]])
  })

  it('returns formatted parameters for strings', () => {
    const result = getFormattedJestTestParameters([['\n    a    | b    | expected\n    '], 1, 2, 3, 3, 5, 8, 0, 1, 1])
    expect(result).to.eql([{ a: 1, b: 2, expected: 3 }, { a: 3, b: 5, expected: 8 }, { a: 0, b: 1, expected: 1 }])
  })

  it('does not crash for invalid inputs', () => {
    const resultUndefined = getFormattedJestTestParameters(undefined)
    const resultEmptyArray = getFormattedJestTestParameters([])
    const resultObject = getFormattedJestTestParameters({})
    expect(resultEmptyArray).to.eql(undefined)
    expect(resultUndefined).to.eql(undefined)
    expect(resultObject).to.eql(undefined)
  })
})

describe('getJestSuitesToRun', () => {
  it('returns filtered suites', () => {
    const skippableSuites = [
      'src/unit.spec.js',
      'src/integration.spec.js'
    ]
    const tests = [
      { path: '/workspace/dd-trace-js/src/unit.spec.js' },
      { path: '/workspace/dd-trace-js/src/integration.spec.js' },
      { path: '/workspace/dd-trace-js/src/e2e.spec.js' }
    ]
    const rootDir = '/workspace/dd-trace-js'

    const { suitesToRun } = getJestSuitesToRun(skippableSuites, tests, rootDir)
    expect(suitesToRun).to.eql([{ path: '/workspace/dd-trace-js/src/e2e.spec.js' }])
  })

  it('returns filtered suites when paths are windows like', () => {
    const skippableSuites = [
      'src/unit.spec.js',
      'src/integration.spec.js'
    ]
    const tests = [
      { path: `C:${path.sep}temp${path.sep}dd-trace-js${path.sep}src${path.sep}unit.spec.js` },
      { path: `C:${path.sep}temp${path.sep}dd-trace-js${path.sep}src${path.sep}integration.spec.js` },
      { path: `C:${path.sep}temp${path.sep}dd-trace-js${path.sep}src${path.sep}e2e.spec.js` }
    ]
    const rootDir = `C:${path.sep}temp${path.sep}dd-trace-js`

    const { suitesToRun } = getJestSuitesToRun(skippableSuites, tests, rootDir)
    expect(suitesToRun).to.eql([
      { path: `C:${path.sep}temp${path.sep}dd-trace-js${path.sep}src${path.sep}e2e.spec.js` }
    ])
  })

  it('returns filtered suites when paths are relative', () => {
    const skippableSuites = [
      '../../src/unit.spec.js',
      '../../src/integration.spec.js'
    ]
    const tests = [
      { path: '/workspace/dd-trace-js/src/unit.spec.js' },
      { path: '/workspace/dd-trace-js/src/integration.spec.js' },
      { path: '/workspace/dd-trace-js/src/e2e.spec.js' }
    ]
    const rootDir = '/workspace/dd-trace-js/config/root-config'

    const { suitesToRun } = getJestSuitesToRun(skippableSuites, tests, rootDir)
    expect(suitesToRun).to.eql([
      { path: '/workspace/dd-trace-js/src/e2e.spec.js' }
    ])
  })

  it('returns the list of skipped suites', () => {
    const skippableSuites = [
      'src/unit.spec.js',
      'src/integration.spec.js',
      'src/not-in-the-repo-so-will-not-show-up-in-skipped-suites.js'
    ]
    const tests = [
      { path: '/workspace/dd-trace-js/src/unit.spec.js' },
      { path: '/workspace/dd-trace-js/src/integration.spec.js' },
      { path: '/workspace/dd-trace-js/src/e2e.spec.js' }
    ]
    const rootDir = '/workspace/dd-trace-js'

    const { skippedSuites } = getJestSuitesToRun(skippableSuites, tests, rootDir)
    expect(skippedSuites).to.eql([
      'src/unit.spec.js',
      'src/integration.spec.js'
    ])
  })

  it('takes unskippable into account', () => {
    const skippableSuites = [
      'fixtures/test-to-skip.js',
      'fixtures/test-unskippable.js'
    ]
    const tests = [
      { path: path.join(__dirname, './fixtures/test-to-run.js') },
      { path: path.join(__dirname, './fixtures/test-to-skip.js') },
      { path: path.join(__dirname, './fixtures/test-unskippable.js') }
    ]
    const rootDir = __dirname

    const { suitesToRun, skippedSuites } = getJestSuitesToRun(skippableSuites, tests, rootDir)
    expect(suitesToRun).to.eql([
      {
        path: path.join(__dirname, './fixtures/test-to-run.js')
      },
      {
        path: path.join(__dirname, './fixtures/test-unskippable.js')
      }
    ])
    expect(skippedSuites).to.eql([
      'fixtures/test-to-skip.js'
    ])
  })

  it('returns hasUnskippableSuites if there is a unskippable suite', () => {
    const skippableSuites = []
    const tests = [
      { path: path.join(__dirname, './fixtures/test-to-run.js'), context: { config: { testEnvironmentOptions: {} } } },
      {
        path: path.join(__dirname, './fixtures/test-unskippable.js'),
        context: { config: { testEnvironmentOptions: {} } }
      }
    ]
    const rootDir = __dirname

    const { hasUnskippableSuites, hasForcedToRunSuites } = getJestSuitesToRun(skippableSuites, tests, rootDir)
    expect(hasUnskippableSuites).to.equal(true)
    expect(hasForcedToRunSuites).to.equal(false)
  })

  it('returns hasForcedToRunSuites if there is a forced to run suite', () => {
    const skippableSuites = ['fixtures/test-unskippable.js']
    const tests = [
      { path: path.join(__dirname, './fixtures/test-to-run.js'), context: { config: { testEnvironmentOptions: {} } } },
      {
        path: path.join(__dirname, './fixtures/test-unskippable.js'),
        context: { config: { testEnvironmentOptions: {} } }
      }
    ]
    const rootDir = __dirname

    const { hasUnskippableSuites, hasForcedToRunSuites } = getJestSuitesToRun(skippableSuites, tests, rootDir)
    expect(hasUnskippableSuites).to.equal(true)
    expect(hasForcedToRunSuites).to.equal(true)
  })

  it('adds extra `testEnvironmentOptions` if suite is unskippable or forced to run', () => {
    const skippableSuites = ['fixtures/test-unskippable.js']
    // tests share a config object
    const globalConfig = { testEnvironmentOptions: {} }
    const tests = [
      {
        path: path.join(__dirname, './fixtures/test-to-run.js'),
        context: { config: globalConfig }
      },
      {
        path: path.join(__dirname, './fixtures/test-unskippable.js'),
        context: { config: globalConfig }
      }
    ]
    const rootDir = __dirname

    getJestSuitesToRun(skippableSuites, tests, rootDir)
    expect(globalConfig.testEnvironmentOptions._ddUnskippable)
      .to.eql(JSON.stringify({ 'fixtures/test-unskippable.js': true }))
    expect(globalConfig.testEnvironmentOptions._ddForcedToRun)
      .to.eql(JSON.stringify({ 'fixtures/test-unskippable.js': true }))
  })
})
