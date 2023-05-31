'use strict'

require('../../setup/tap')

const path = require('path')
const istanbul = require('istanbul-lib-coverage')

const {
  getTestParametersString,
  getTestSuitePath,
  getCodeOwnersFileEntries,
  getCodeOwnersForFilename,
  getCoveredFilenamesFromCoverage,
  mergeCoverage,
  resetCoverage
} = require('../../../src/plugins/util/test')

describe('getTestParametersString', () => {
  it('returns formatted test parameters and removes params from input', () => {
    const input = { 'test_stuff': [['params'], [{ b: 'c' }]] }
    expect(getTestParametersString(input, 'test_stuff')).to.equal(
      JSON.stringify({ arguments: ['params'], metadata: {} })
    )
    expect(input).to.eql({ 'test_stuff': [[{ b: 'c' }]] })
    expect(getTestParametersString(input, 'test_stuff')).to.equal(
      JSON.stringify({ arguments: [{ b: 'c' }], metadata: {} })
    )
    expect(input).to.eql({ 'test_stuff': [] })
  })
  it('does not crash when test name is not found and does not modify input', () => {
    const input = { 'test_stuff': [['params'], ['params2']] }
    expect(getTestParametersString(input, 'test_not_present')).to.equal('')
    expect(input).to.eql({ 'test_stuff': [['params'], ['params2']] })
  })
  it('does not crash when parameters can not be serialized and removes params from input', () => {
    const circular = { a: 'b' }
    circular.b = circular

    const input = { 'test_stuff': [[circular], ['params2']] }
    expect(getTestParametersString(input, 'test_stuff')).to.equal('')
    expect(input).to.eql({ 'test_stuff': [['params2']] })
    expect(getTestParametersString(input, 'test_stuff')).to.equal(
      JSON.stringify({ arguments: ['params2'], metadata: {} })
    )
  })
})

describe('getTestSuitePath', () => {
  it('returns sourceRoot if the test path is falsy', () => {
    const sourceRoot = '/users/opt'
    const testSuitePath = getTestSuitePath(undefined, sourceRoot)
    expect(testSuitePath).to.equal(sourceRoot)
  })
  it('returns sourceRoot if the test path has the same value', () => {
    const sourceRoot = '/users/opt'
    const testSuiteAbsolutePath = sourceRoot
    const testSuitePath = getTestSuitePath(testSuiteAbsolutePath, sourceRoot)
    expect(testSuitePath).to.equal(sourceRoot)
  })
})

describe('getCodeOwnersFileEntries', () => {
  it('returns code owners entries', () => {
    const rootDir = path.join(__dirname, '__test__')
    const codeOwnersFileEntries = getCodeOwnersFileEntries(rootDir)

    expect(codeOwnersFileEntries[0]).to.eql({
      pattern: 'packages/dd-trace/test/plugins/util/test.spec.js',
      owners: ['@datadog-ci-app']
    })
    expect(codeOwnersFileEntries[1]).to.eql({
      pattern: 'packages/dd-trace/test/plugins/util/*',
      owners: ['@datadog-dd-trace-js']
    })
  })
  it('returns null if CODEOWNERS can not be found', () => {
    const rootDir = path.join(__dirname, '__not_found__')
    const codeOwnersFileEntries = getCodeOwnersFileEntries(rootDir)

    expect(codeOwnersFileEntries).to.equal(null)
  })
})

describe('getCodeOwnersForFilename', () => {
  it('returns null if entries is empty', () => {
    const codeOwners = getCodeOwnersForFilename('filename', undefined)

    expect(codeOwners).to.equal(null)
  })
  it('returns the code owners for a given file path', () => {
    const rootDir = path.join(__dirname, '__test__')
    const codeOwnersFileEntries = getCodeOwnersFileEntries(rootDir)

    const codeOwnersForGitSpec = getCodeOwnersForFilename(
      'packages/dd-trace/test/plugins/util/git.spec.js',
      codeOwnersFileEntries
    )

    expect(codeOwnersForGitSpec).to.equal(JSON.stringify(['@datadog-dd-trace-js']))

    const codeOwnersForTestSpec = getCodeOwnersForFilename(
      'packages/dd-trace/test/plugins/util/test.spec.js',
      codeOwnersFileEntries
    )

    expect(codeOwnersForTestSpec).to.equal(JSON.stringify(['@datadog-ci-app']))
  })
})

describe('coverage utils', () => {
  let coverage
  beforeEach(() => {
    delete require.cache[require.resolve('./fixtures/coverage.json')]
    coverage = require('./fixtures/coverage.json')
  })
  describe('getCoveredFilenamesFromCoverage', () => {
    it('returns the list of files the code coverage includes', () => {
      const coverageFiles = getCoveredFilenamesFromCoverage(coverage)
      expect(coverageFiles).to.eql(['subtract.js', 'add.js'])
    })
    it('returns an empty list if coverage is empty', () => {
      const coverageFiles = getCoveredFilenamesFromCoverage({})
      expect(coverageFiles).to.eql([])
    })
  })

  describe('resetCoverage', () => {
    it('resets the code coverage', () => {
      resetCoverage(coverage)
      const coverageFiles = getCoveredFilenamesFromCoverage(coverage)
      expect(coverageFiles).to.eql([])
    })
  })

  describe('mergeCoverage', () => {
    it('copies the code coverage', () => {
      const newCoverageMap = istanbul.createCoverageMap()
      // At first it's different, then it is the same after copying
      expect(JSON.stringify(coverage)).not.to.equal(JSON.stringify(newCoverageMap.toJSON()))
      mergeCoverage(coverage, newCoverageMap)
      expect(JSON.stringify(coverage)).to.equal(JSON.stringify(newCoverageMap.toJSON()))
    })
    it('returns a copy that is not affected by other copies being reset', () => {
      const newCoverageMap = istanbul.createCoverageMap()

      expect(JSON.stringify(coverage)).not.to.equal(JSON.stringify(newCoverageMap.toJSON()))
      mergeCoverage(coverage, newCoverageMap)

      const originalCoverageJson = JSON.stringify(coverage)
      const copiedCoverageJson = JSON.stringify(newCoverageMap.toJSON())
      expect(originalCoverageJson).to.equal(copiedCoverageJson)

      // The original coverage is reset
      resetCoverage(coverage)

      // The original coverage JSON representation changes
      expect(originalCoverageJson).not.to.equal(JSON.stringify(coverage))

      // The original coverage JSON representation is not the same as the copied coverage
      expect(JSON.stringify(coverage)).not.to.equal(JSON.stringify(newCoverageMap.toJSON()))

      // The copied coverage remains the same after the original reset
      expect(copiedCoverageJson).to.equal(JSON.stringify(newCoverageMap.toJSON()))
    })
  })
})
