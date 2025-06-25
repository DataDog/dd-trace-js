'use strict'

const t = require('tap')
require('../../setup/core')

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
  parseAnnotations,
  getIsFaultyEarlyFlakeDetection,
  getNumFromKnownTests,
  getModifiedTestsFromDiff,
  isModifiedTest
} = require('../../../src/plugins/util/test')

const proxyquire = require('proxyquire')
const { GIT_REPOSITORY_URL, GIT_COMMIT_SHA, CI_PIPELINE_URL } = require('../../../src/plugins/util/tags')
const {
  TELEMETRY_GIT_COMMIT_SHA_DISCREPANCY,
  TELEMETRY_GIT_SHA_MATCH
} = require('../../../src/ci-visibility/telemetry')

t.test('getTestParametersString', t => {
  t.test('returns formatted test parameters and removes params from input', t => {
    const input = { test_stuff: [['params'], [{ b: 'c' }]] }
    expect(getTestParametersString(input, 'test_stuff')).to.equal(
      JSON.stringify({ arguments: ['params'], metadata: {} })
    )
    expect(input).to.eql({ test_stuff: [[{ b: 'c' }]] })
    expect(getTestParametersString(input, 'test_stuff')).to.equal(
      JSON.stringify({ arguments: [{ b: 'c' }], metadata: {} })
    )
    expect(input).to.eql({ test_stuff: [] })
    t.end()
  })

  t.test('does not crash when test name is not found and does not modify input', t => {
    const input = { test_stuff: [['params'], ['params2']] }
    expect(getTestParametersString(input, 'test_not_present')).to.equal('')
    expect(input).to.eql({ test_stuff: [['params'], ['params2']] })
    t.end()
  })

  t.test('does not crash when parameters can not be serialized and removes params from input', t => {
    const circular = { a: 'b' }
    circular.b = circular

    const input = { test_stuff: [[circular], ['params2']] }
    expect(getTestParametersString(input, 'test_stuff')).to.equal('')
    expect(input).to.eql({ test_stuff: [['params2']] })
    expect(getTestParametersString(input, 'test_stuff')).to.equal(
      JSON.stringify({ arguments: ['params2'], metadata: {} })
    )
    t.end()
  })
  t.end()
})

t.test('getTestSuitePath', t => {
  t.test('returns sourceRoot if the test path is falsy', t => {
    const sourceRoot = '/users/opt'
    const testSuitePath = getTestSuitePath(undefined, sourceRoot)
    expect(testSuitePath).to.equal(sourceRoot)
    t.end()
  })

  t.test('returns sourceRoot if the test path has the same value', t => {
    const sourceRoot = '/users/opt'
    const testSuiteAbsolutePath = sourceRoot
    const testSuitePath = getTestSuitePath(testSuiteAbsolutePath, sourceRoot)
    expect(testSuitePath).to.equal(sourceRoot)
    t.end()
  })
  t.end()
})

t.test('getCodeOwnersFileEntries', t => {
  t.test('returns code owners entries', t => {
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
    t.end()
  })

  t.test('returns null if CODEOWNERS can not be found', t => {
    const rootDir = path.join(__dirname, '__not_found__')
    // We have to change the working directory,
    // otherwise it will find the CODEOWNERS file in the root of dd-trace-js
    const oldCwd = process.cwd()
    process.chdir(path.join(__dirname))
    const codeOwnersFileEntries = getCodeOwnersFileEntries(rootDir)
    expect(codeOwnersFileEntries).to.equal(null)
    process.chdir(oldCwd)
    t.end()
  })

  t.test('tries both input rootDir and process.cwd()', t => {
    const rootDir = path.join(__dirname, '__not_found__')
    const oldCwd = process.cwd()

    process.chdir(path.join(__dirname, '__test__'))
    const codeOwnersFileEntries = getCodeOwnersFileEntries(rootDir)

    expect(codeOwnersFileEntries[0]).to.eql({
      pattern: 'packages/dd-trace/test/plugins/util/test.spec.js',
      owners: ['@datadog-ci-app']
    })
    expect(codeOwnersFileEntries[1]).to.eql({
      pattern: 'packages/dd-trace/test/plugins/util/*',
      owners: ['@datadog-dd-trace-js']
    })
    process.chdir(oldCwd)
    t.end()
  })
  t.end()
})

t.test('getCodeOwnersForFilename', t => {
  t.test('returns null if entries is empty', t => {
    const codeOwners = getCodeOwnersForFilename('filename', undefined)

    expect(codeOwners).to.equal(null)
    t.end()
  })

  t.test('returns the code owners for a given file path', t => {
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
    t.end()
  })
  t.end()
})

t.test('coverage utils', t => {
  let coverage

  t.beforeEach(() => {
    delete require.cache[require.resolve('./fixtures/coverage.json')]
    coverage = require('./fixtures/coverage.json')
  })

  t.test('getCoveredFilenamesFromCoverage', t => {
    t.test('returns the list of files the code coverage includes', t => {
      const coverageFiles = getCoveredFilenamesFromCoverage(coverage)
      expect(coverageFiles).to.eql(['subtract.js', 'add.js'])
      t.end()
    })

    t.test('returns an empty list if coverage is empty', t => {
      const coverageFiles = getCoveredFilenamesFromCoverage({})
      expect(coverageFiles).to.eql([])
      t.end()
    })
    t.end()
  })

  t.test('resetCoverage', t => {
    t.test('resets the code coverage', t => {
      resetCoverage(coverage)
      const coverageFiles = getCoveredFilenamesFromCoverage(coverage)
      expect(coverageFiles).to.eql([])
      t.end()
    })
    t.end()
  })

  t.test('mergeCoverage', t => {
    t.test('copies the code coverage', t => {
      const newCoverageMap = istanbul.createCoverageMap()
      // At first it's different, then it is the same after copying
      expect(JSON.stringify(coverage)).not.to.equal(JSON.stringify(newCoverageMap.toJSON()))
      mergeCoverage(coverage, newCoverageMap)
      expect(JSON.stringify(coverage)).to.equal(JSON.stringify(newCoverageMap.toJSON()))
      t.end()
    })

    t.test('returns a copy that is not affected by other copies being reset', t => {
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
      t.end()
    })
    t.end()
  })
  t.end()
})

t.test('metadata validation', t => {
  t.test('should remove invalid metadata', t => {
    const invalidMetadata1 = {
      [GIT_REPOSITORY_URL]: 'www.datadog.com',
      [CI_PIPELINE_URL]: 'www.datadog.com',
      [GIT_COMMIT_SHA]: 'abc123'
    }
    const invalidMetadata2 = {
      [GIT_REPOSITORY_URL]: 'htps://datadog.com/repo',
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
      expect(
        JSON.stringify(removeInvalidMetadata(invalidMetadata)), `${JSON.stringify(invalidMetadata)} is valid`
      ).to.equal(JSON.stringify({}))
    })
    t.end()
  })

  t.test('should keep valid metadata', t => {
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
    t.end()
  })
  t.end()
})

t.test('parseAnnotations', t => {
  t.test('parses correctly shaped annotations', t => {
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
    t.end()
  })

  t.test('does not crash with invalid arguments', t => {
    const tags = parseAnnotations([
      {},
      'invalid',
      { type: 'DD_TAGS', description: 'yeah' },
      { type: 'DD_TAGS[v', description: 'invalid' },
      { type: 'test.requirement', description: 'sure' }
    ])
    expect(tags).to.eql({})
    t.end()
  })
  t.end()
})

t.test('getIsFaultyEarlyFlakeDetection', t => {
  t.test('returns false if the absolute number of new suites is smaller or equal than the threshold', t => {
    const faultyThreshold = 30

    // Session has 50 tests and 25 are marked as new (50%): not faulty.
    const projectSuites = Array.from({ length: 50 }).map((_, i) => `test${i}.spec.js`)
    const knownSuites = Array.from({ length: 25 }).reduce((acc, _, i) => {
      acc[`test${i}.spec.js`] = ['test']
      return acc
    }, {})

    const isFaulty = getIsFaultyEarlyFlakeDetection(
      projectSuites,
      knownSuites,
      faultyThreshold
    )
    expect(isFaulty).to.be.false

    // Session has 60 tests and 30 are marked as new (50%): not faulty.
    const projectSuites2 = Array.from({ length: 60 }).map((_, i) => `test${i}.spec.js`)
    const knownSuites2 = Array.from({ length: 30 }).reduce((acc, _, i) => {
      acc[`test${i}.spec.js`] = ['test']
      return acc
    }, {})
    const isFaulty2 = getIsFaultyEarlyFlakeDetection(
      projectSuites2,
      knownSuites2,
      faultyThreshold
    )
    expect(isFaulty2).to.be.false
    t.end()
  })

  t.test('returns true if the percentage is above the threshold', t => {
    const faultyThreshold = 30

    // Session has 100 tests and 31 are marked as new (31%): faulty.
    const projectSuites = Array.from({ length: 100 }).map((_, i) => `test${i}.spec.js`)
    const knownSuites = Array.from({ length: 69 }).reduce((acc, _, i) => {
      acc[`test${i}.spec.js`] = ['test']
      return acc
    }, {})

    const isFaulty = getIsFaultyEarlyFlakeDetection(
      projectSuites,
      knownSuites,
      faultyThreshold
    )
    expect(isFaulty).to.be.true
    t.end()
  })
  t.end()
})

t.test('getNumFromKnownTests', t => {
  t.test('calculates the number of tests from the known tests', t => {
    const knownTests = {
      testModule: {
        'test1.spec.js': ['test1', 'test2'],
        'test2.spec.js': ['test3']
      }
    }

    const numTests = getNumFromKnownTests(knownTests)
    expect(numTests).to.equal(3)
    t.end()
  })

  t.test('does not crash with empty dictionaries', t => {
    const knownTests = {}

    const numTests = getNumFromKnownTests(knownTests)
    expect(numTests).to.equal(0)
    t.end()
  })

  t.test('does not crash if known tests is undefined or null', t => {
    const numTestsUndefined = getNumFromKnownTests(undefined)
    expect(numTestsUndefined).to.equal(0)

    const numTestsNull = getNumFromKnownTests(null)
    expect(numTestsNull).to.equal(0)
    t.end()
  })
  t.end()
})

t.test('getModifiedTestsFromDiff', t => {
  t.test('should parse git diff and return modified lines per file', t => {
    const diff = `diff --git a/test/file1.js b/test/file1.js
index 1234567..89abcde 100644
--- a/test/file1.js
+++ b/test/file1.js
@@ -2 +2 @@
-line2
+line2 modified
@@ -4,0 +4,1 @@
+new line
diff --git a/test/file2.js b/test/file2.js
index 1234567..89abcde 100644
--- a/test/file2.js
+++ b/test/file2.js
@@ -5,0 +5,1 @@
+new line`

    const expected = {
      'test/file1.js': [2, 4],
      'test/file2.js': [5]
    }

    expect(getModifiedTestsFromDiff(diff)).to.eql(expected)
    t.end()
  })

  t.test('should return null for empty or invalid diff', t => {
    expect(getModifiedTestsFromDiff('')).to.be.null
    expect(getModifiedTestsFromDiff(null)).to.be.null
    expect(getModifiedTestsFromDiff(undefined)).to.be.null
    t.end()
  })

  t.test('should handle multiple line changes in a single hunk', t => {
    const diff = `diff --git a/test/file.js b/test/file.js
index 1234567..89abcde 100644
--- a/test/file.js
+++ b/test/file.js
@@ -2 +2 @@
-line2
+line2 modified
@@ -4,0 +4,1 @@
+new line
@@ -6,0 +6,1 @@
+another new line`

    const expected = {
      'test/file.js': [2, 4, 6]
    }

    expect(getModifiedTestsFromDiff(diff)).to.eql(expected)
    t.end()
  })
  t.end()
})

t.test('isModifiedTest', t => {
  t.test('when tests come from local diff', t => {
    const testFramework = 'jest'

    t.test('should return true when test lines overlap with modified lines', t => {
      const modifiedTests = {
        'test/file.js': [2, 4, 6]
      }
      expect(isModifiedTest('test/file.js', 1, 3, modifiedTests, testFramework)).to.be.true // overlaps with line 2
      expect(isModifiedTest('test/file.js', 3, 5, modifiedTests, testFramework)).to.be.true // overlaps with line 4
      expect(isModifiedTest('test/file.js', 5, 7, modifiedTests, testFramework)).to.be.true // overlaps with line 6
      t.end()
    })

    t.test('should return false when test lines do not overlap with modified lines', t => {
      const modifiedTests = {
        'test/file.js': [2, 4, 6]
      }
      expect(isModifiedTest('test/file.js', 7, 9, modifiedTests, testFramework)).to.be.false
      expect(isModifiedTest('test/file.js', 0, 1, modifiedTests, testFramework)).to.be.false
      t.end()
    })

    t.test('should return false when file is not in modified tests', t => {
      const modifiedTests = {
        'test/file.js': [2, 4, 6]
      }
      expect(isModifiedTest('test/other.js', 1, 3, modifiedTests, testFramework)).to.be.false
      t.end()
    })

    t.test('should handle single line tests', t => {
      const modifiedTests = {
        'test/file.js': [2, 4, 6]
      }
      expect(isModifiedTest('test/file.js', 2, 2, modifiedTests, testFramework)).to.be.true
      expect(isModifiedTest('test/file.js', 3, 3, modifiedTests, testFramework)).to.be.false
      t.end()
    })
    t.end()
  })

  t.test('when tests frameworks do not support granular impacted tests', t => {
    const testFramework = 'playwright'

    t.test('should return true when test file is in modifiedTests', t => {
      const modifiedTests = {
        'test/file.js': [2, 4, 6],
        'test/other.js': [2, 4, 6]
      }
      expect(isModifiedTest('test/file.js', 1, 10, modifiedTests, testFramework)).to.be.true
      expect(isModifiedTest('test/other.js', 1, 10, modifiedTests, testFramework)).to.be.true
      t.end()
    })

    t.test('should return false when test file is not in modifiedTests', t => {
      const modifiedTests = {
        'test/file.js': [2, 4, 6]
      }
      expect(isModifiedTest('test/other.js', 1, 10, modifiedTests, testFramework)).to.be.false
      t.end()
    })
    t.end()
  })

  t.test('should handle empty modifiedTests object', t => {
    expect(isModifiedTest('test/file.js', 1, 10, {}, 'jest')).to.be.false
    t.end()
  })
  t.end()
})

t.test('getPullRequestBaseBranch', t => {
  context('there is a pull request base branch', () => {
    t.test('returns base commit SHA to compare against ', t => {
      const getMergeBaseStub = sinon.stub()
      getMergeBaseStub.returns('1234af')
      const checkAndFetchBranchStub = sinon.stub()
      const getLocalBranchesStub = sinon.stub()
      const { getPullRequestBaseBranch } = proxyquire('../../../src/plugins/util/test', {
        './git': {
          getGitRemoteName: () => 'origin',
          getSourceBranch: () => 'feature-branch',
          getMergeBase: getMergeBaseStub,
          checkAndFetchBranch: checkAndFetchBranchStub,
          getLocalBranches: getLocalBranchesStub
        }
      })
      const baseBranch = getPullRequestBaseBranch('trunk')
      expect(baseBranch).to.equal('1234af')
      expect(checkAndFetchBranchStub).to.have.been.calledWith('trunk', 'origin')
      expect(getMergeBaseStub).to.have.been.calledWith('trunk', 'feature-branch')
      expect(getLocalBranchesStub).not.to.have.been.called
      t.end()
    })
  })

  context('there is no pull request base branch', () => {
    t.test('returns the best base branch SHA from local branches', t => {
      const checkAndFetchBranchStub = sinon.stub()
      const getLocalBranchesStub = sinon.stub().returns(['trunk', 'master', 'feature-branch'])

      const getMergeBaseStub = sinon.stub()
      getMergeBaseStub.withArgs('trunk', 'feature-branch').returns('1234af')
      getMergeBaseStub.withArgs('master', 'feature-branch').returns('fa4321')

      const getCountsStub = sinon.stub()
      getCountsStub.withArgs('trunk', 'feature-branch').returns({ ahead: 0, behind: 0 })
      // master should be chosen because even though it has the same "ahead" value, it is a default branch
      getCountsStub.withArgs('master', 'feature-branch').returns({ ahead: 0, behind: 1 })

      const { getPullRequestBaseBranch, POSSIBLE_BASE_BRANCHES } = proxyquire('../../../src/plugins/util/test', {
        './git': {
          getGitRemoteName: () => 'origin',
          getSourceBranch: () => 'feature-branch',
          getMergeBase: getMergeBaseStub,
          checkAndFetchBranch: checkAndFetchBranchStub,
          getLocalBranches: getLocalBranchesStub,
          getCounts: getCountsStub
        }
      })
      const baseBranch = getPullRequestBaseBranch()
      expect(baseBranch).to.equal('fa4321')

      POSSIBLE_BASE_BRANCHES.forEach((baseBranch) => {
        expect(checkAndFetchBranchStub).to.have.been.calledWith(baseBranch, 'origin')
      })
      expect(getLocalBranchesStub).to.have.been.calledWith('origin')
      expect(getMergeBaseStub).to.have.been.calledWith('master', 'feature-branch')
      expect(getMergeBaseStub).to.have.been.calledWith('trunk', 'feature-branch')
      expect(getCountsStub).to.have.been.calledWith('master', 'feature-branch')
      expect(getCountsStub).to.have.been.calledWith('trunk', 'feature-branch')
      t.end()
    })
  })
  t.end()
})

t.test('checkShaDiscrepancies', t => {
  const incrementCountMetricStub = sinon.stub()

  t.test('return true if the CI/Git Client repository URL is different from the user provided repository URL', t => {
    const ciMetadata = {
      [GIT_COMMIT_SHA]: '1234af',
      [GIT_REPOSITORY_URL]: 'https://github.com/datadog/dd-trace-js.git'
    }
    const userProvidedGitMetadata = {
      [GIT_COMMIT_SHA]: '1234af',
      [GIT_REPOSITORY_URL]: 'Bad URL'
    }
    const getGitInformationDiscrepancyStub = sinon.stub()
    getGitInformationDiscrepancyStub.returns({
      gitRepositoryUrl: 'Bad URL 2',
      gitCommitSHA: '1234af'
    })
    const { checkShaDiscrepancies } = proxyquire('../../../src/plugins/util/test', {
      './git': {
        getGitInformationDiscrepancy: getGitInformationDiscrepancyStub
      },
      '../../ci-visibility/telemetry': {
        incrementCountMetric: incrementCountMetricStub
      }
    })

    checkShaDiscrepancies(ciMetadata, userProvidedGitMetadata)

    const expectedCalls = [
      { type: 'repository_discrepancy', expectedProvider: 'user_supplied', discrepantProvider: 'git_client' },
      { type: 'repository_discrepancy', expectedProvider: 'user_supplied', discrepantProvider: 'ci_provider' },
      { type: 'repository_discrepancy', expectedProvider: 'ci_provider', discrepantProvider: 'git_client' }
    ]

    expectedCalls.forEach(({ type, expectedProvider, discrepantProvider }) => {
      expect(incrementCountMetricStub).to.have.been.calledWith(TELEMETRY_GIT_COMMIT_SHA_DISCREPANCY, {
        type,
        expected_provider: expectedProvider,
        discrepant_provider: discrepantProvider
      })
    })
    expect(incrementCountMetricStub).to.have.been.calledWith(TELEMETRY_GIT_SHA_MATCH, { match: false })
    t.end()
  })

  t.test('return true if the CI/Git Client commit SHA is different from the user provided commit SHA', t => {
    incrementCountMetricStub.resetHistory()
    const ciMetadata = {
      [GIT_COMMIT_SHA]: 'abcd',
      [GIT_REPOSITORY_URL]: 'https://github.com/datadog/dd-trace-js.git'
    }
    const userProvidedGitMetadata = {
      [GIT_COMMIT_SHA]: 'efgh',
      [GIT_REPOSITORY_URL]: 'https://github.com/datadog/dd-trace-js.git'
    }
    const getGitInformationDiscrepancyStub = sinon.stub()
    getGitInformationDiscrepancyStub.returns({
      gitRepositoryUrl: 'https://github.com/datadog/dd-trace-js.git',
      gitCommitSHA: 'ijkl'
    })
    const { checkShaDiscrepancies } = proxyquire('../../../src/plugins/util/test', {
      './git': {
        getGitInformationDiscrepancy: getGitInformationDiscrepancyStub
      },
      '../../ci-visibility/telemetry': {
        incrementCountMetric: incrementCountMetricStub
      }
    })

    checkShaDiscrepancies(ciMetadata, userProvidedGitMetadata)

    const expectedCalls = [
      { type: 'commit_discrepancy', expectedProvider: 'user_supplied', discrepantProvider: 'git_client' },
      { type: 'commit_discrepancy', expectedProvider: 'user_supplied', discrepantProvider: 'ci_provider' },
      { type: 'commit_discrepancy', expectedProvider: 'ci_provider', discrepantProvider: 'git_client' }
    ]

    expectedCalls.forEach(({ type, expectedProvider, discrepantProvider }) => {
      expect(incrementCountMetricStub).to.have.been.calledWith(TELEMETRY_GIT_COMMIT_SHA_DISCREPANCY, {
        type,
        expected_provider: expectedProvider,
        discrepant_provider: discrepantProvider
      })
    })
    expect(incrementCountMetricStub).to.have.been.calledWith(TELEMETRY_GIT_SHA_MATCH, { match: false })
    t.end()
  })

  t.test('increment TELEMETRY_GIT_SHA_MATCH with match: true when all values match', t => {
    incrementCountMetricStub.resetHistory()
    const ciMetadata = {
      [GIT_COMMIT_SHA]: '1234af',
      [GIT_REPOSITORY_URL]: 'https://github.com/datadog/dd-trace-js.git'
    }
    const userProvidedGitMetadata = {
      [GIT_COMMIT_SHA]: '1234af',
      [GIT_REPOSITORY_URL]: 'https://github.com/datadog/dd-trace-js.git'
    }
    const getGitInformationDiscrepancyStub = sinon.stub()
    getGitInformationDiscrepancyStub.returns({
      gitRepositoryUrl: 'https://github.com/datadog/dd-trace-js.git',
      gitCommitSHA: '1234af'
    })
    const { checkShaDiscrepancies } = proxyquire('../../../src/plugins/util/test', {
      './git': {
        getGitInformationDiscrepancy: getGitInformationDiscrepancyStub
      },
      '../../ci-visibility/telemetry': {
        incrementCountMetric: incrementCountMetricStub
      }
    })

    checkShaDiscrepancies(ciMetadata, userProvidedGitMetadata)

    expect(incrementCountMetricStub).to.have.been.calledWith(TELEMETRY_GIT_SHA_MATCH, { match: true })
    t.end()
  })
  t.end()
})
