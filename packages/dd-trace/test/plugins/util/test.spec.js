'use strict'

require('../../setup/tap')

const path = require('path')

const {
  getTestParametersString,
  getTestSuitePath,
  getCodeOwnersFileEntries,
  getCodeOwnersForFilename
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
