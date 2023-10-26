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
  resetCoverage,
  removeInvalidMetadata,
  parseAnnotations
} = require('../../../src/plugins/util/test')

const { GIT_REPOSITORY_URL, GIT_COMMIT_SHA, CI_PIPELINE_URL } = require('../../../src/plugins/util/tags')

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

describe('metadata validation', () => {
  it('should remove invalid metadata', () => {
    const invalidMetadata1 = {
      [GIT_REPOSITORY_URL]: 'www.datadog.com',
      [CI_PIPELINE_URL]: 'www.datadog.com',
      [GIT_COMMIT_SHA]: 'abc123'
    }
    const invalidMetadata2 = {
      [GIT_REPOSITORY_URL]: 'https://datadog.com/repo',
      [CI_PIPELINE_URL]: 'datadog.com',
      [GIT_COMMIT_SHA]: 'abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123'
    }
    const invalidMetadata3 = {
      [GIT_REPOSITORY_URL]: 'datadog.com',
      [CI_PIPELINE_URL]: 'datadog.com',
      [GIT_COMMIT_SHA]: 'abc123'
    }
    const invalidMetadata4 = {
      [GIT_REPOSITORY_URL]: 'datadog.com/repo.git',
      [CI_PIPELINE_URL]: 'www.datadog.com5',
      [GIT_COMMIT_SHA]: 'abc123'
    }
    const invalidMetadata5 = { [GIT_REPOSITORY_URL]: '', [CI_PIPELINE_URL]: '', [GIT_COMMIT_SHA]: '' }
    const invalidMetadatas = [invalidMetadata1, invalidMetadata2, invalidMetadata3, invalidMetadata4, invalidMetadata5]
    invalidMetadatas.forEach((invalidMetadata) => {
      expect(JSON.stringify(removeInvalidMetadata(invalidMetadata))).to.equal(JSON.stringify({}))
    })
  })
  it('should keep valid metadata', () => {
    const validMetadata1 = {
      [GIT_REPOSITORY_URL]: 'https://datadoghq.com/myrepo/repo.git',
      [CI_PIPELINE_URL]: 'https://datadog.com',
      [GIT_COMMIT_SHA]: 'cb466452bfe18d4f6be2836c2a5551843013cf381234223920318230492823f3'
    }
    const validMetadata2 = {
      [GIT_REPOSITORY_URL]: 'http://datadoghq.com/myrepo/repo.git',
      [CI_PIPELINE_URL]: 'http://datadog.com',
      [GIT_COMMIT_SHA]: 'cb466452bfe18d4f6be2836c2a5551843013cf38'
    }
    const validMetadata3 = {
      [GIT_REPOSITORY_URL]: 'git@github.com:DataDog/dd-trace-js.git',
      [CI_PIPELINE_URL]: 'https://datadog.com/pipeline',
      [GIT_COMMIT_SHA]: 'cb466452bfe18d4f6be2836c2a5551843013cf381234223920318230492823f3'
    }
    const validMetadatas = [validMetadata1, validMetadata2, validMetadata3]
    validMetadatas.forEach((validMetadata) => {
      expect(JSON.stringify(removeInvalidMetadata(validMetadata))).to.be.equal(JSON.stringify(validMetadata))
    })
  })
})

describe('parseAnnotations', () => {
  it('parses correctly shaped annotations', () => {
    const tags = parseAnnotations([
      {
        type: 'DD_TAGS[test.requirement]',
        description: 'high'
      },
      {
        type: 'DD_TAGS[test.responsible_team]',
        description: 'sales'
      }
    ])
    expect(tags).to.eql({
      'test.requirement': 'high',
      'test.responsible_team': 'sales'
    })
  })
  it('does not crash with invalid arguments', () => {
    const tags = parseAnnotations([
      {},
      'invalid',
      { type: 'DD_TAGS', description: 'yeah' },
      { type: 'DD_TAGS[v', description: 'invalid' },
      { type: 'test.requirement', description: 'sure' }
    ])
    expect(tags).to.eql({})
  })
})
