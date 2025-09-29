'use strict'

const { expect } = require('chai')
const fs = require('fs')
const path = require('path')
const os = require('os')
const rimraf = require('rimraf')
const { execSync } = require('child_process')

const { createSandbox } = require('../helpers')

const FIXED_COMMIT_MESSAGE = 'Test commit message for caching'
const GET_COMMIT_MESSAGE_COMMAND_ARGS = ['log', '-1', '--pretty=format:%s']

function removeGitFromPath () {
  process.env.PATH = process.env.PATH
    .split(path.delimiter)
    .filter(dir => {
      return !dir.includes('git') &&
             !dir.includes('Git') &&
             !dir.includes('usr/bin') &&
             !dir.includes('bin')
    })
    .join(path.delimiter)
}

describe('git-cache integration tests', () => {
  let sandbox, cwd, gitCache, testRepoPath
  let originalPath, originalCwd
  let cacheDir
  let originalCacheEnabled, originalCacheDir

  before(async () => {
    sandbox = await createSandbox([], true)
    cwd = sandbox.folder
    testRepoPath = cwd

    cacheDir = path.join(os.tmpdir(), 'dd-trace-git-cache-integration-test')
    originalCacheEnabled = process.env.DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_ENABLED
    originalCacheDir = process.env.DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_DIR

    execSync(`git commit --allow-empty -m '${FIXED_COMMIT_MESSAGE}'`, { cwd: testRepoPath })
  })

  after(async () => {
    await sandbox.remove()
  })

  beforeEach(() => {
    process.env.DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_ENABLED = 'true'
    process.env.DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_DIR = cacheDir
    // We need this, otherwise the file is already loaded and the cache is disabled
    delete require.cache[require.resolve('../../packages/dd-trace/src/plugins/util/git-cache')]
    gitCache = require('../../packages/dd-trace/src/plugins/util/git-cache')

    originalPath = process.env.PATH
    originalCwd = process.cwd()
    process.chdir(testRepoPath)
  })

  afterEach(() => {
    if (cacheDir && fs.existsSync(cacheDir)) {
      rimraf.sync(cacheDir)
    }
    process.env.DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_ENABLED = originalCacheEnabled
    process.env.DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_DIR = originalCacheDir
    process.env.PATH = originalPath
    process.chdir(originalCwd)
  })

  it('should cache git commands', function () {
    const firstResult = gitCache.cachedExec('git', GET_COMMIT_MESSAGE_COMMAND_ARGS)

    const firstResultStr = firstResult.toString().trim()
    expect(firstResultStr).to.equal(FIXED_COMMIT_MESSAGE)

    const cacheKey = gitCache.getCacheKey('git', GET_COMMIT_MESSAGE_COMMAND_ARGS)
    const cacheFilePath = gitCache.getCacheFilePath(cacheKey)
    expect(fs.existsSync(cacheFilePath)).to.be.true

    const cachedContent = fs.readFileSync(cacheFilePath, 'utf8')
    expect(cachedContent).to.equal(firstResultStr)
  })

  it('should return cached results when git is unavailable', function () {
    const firstResult = gitCache.cachedExec('git', GET_COMMIT_MESSAGE_COMMAND_ARGS).toString().trim()

    expect(firstResult).to.equal(FIXED_COMMIT_MESSAGE)

    const cacheKey = gitCache.getCacheKey('git', GET_COMMIT_MESSAGE_COMMAND_ARGS)
    const cacheFilePath = gitCache.getCacheFilePath(cacheKey)
    expect(fs.existsSync(cacheFilePath)).to.be.true

    removeGitFromPath()

    const secondResult = gitCache.cachedExec('git', GET_COMMIT_MESSAGE_COMMAND_ARGS).toString().trim()
    expect(secondResult).to.equal(firstResult)

    let secondError
    try {
      gitCache.cachedExec('git', ['rev-parse', 'HEAD'])
    } catch (error) {
      secondError = error
    }
    expect(secondError).to.be.an('error')
    expect(secondError.code).to.equal('ENOENT')
    expect(secondError.message).to.include('git')
  })

  it('should cache git command failures and throw the same error on subsequent calls', function () {
    const gitArgs = ['nonexistent-command']

    let firstError
    try {
      firstError = gitCache.cachedExec('git', gitArgs)
    } catch (error) {
      firstError = error
    }

    expect(firstError).to.be.an('error')

    const cacheKey = gitCache.getCacheKey('git', gitArgs)
    const cacheFilePath = gitCache.getCacheFilePath(cacheKey)
    expect(fs.existsSync(cacheFilePath)).to.be.true

    const cachedData = fs.readFileSync(cacheFilePath, 'utf8')
    expect(cachedData).to.include('__GIT_COMMAND_FAILED__')

    removeGitFromPath()

    // Second call: should throw the same error from cache
    let secondError
    try {
      gitCache.cachedExec('git', gitArgs)
    } catch (error) {
      secondError = error
    }

    expect(secondError).to.be.an('error')
    expect(secondError.message).to.equal(firstError.message)
    expect(secondError.code).to.equal(firstError.code)
    expect(secondError.status).to.equal(firstError.status)
    expect(secondError.errno).to.equal(firstError.errno)
  })

  it('should not cache when DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_ENABLED is not set to true', function () {
    delete process.env.DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_ENABLED

    delete require.cache[require.resolve('../../packages/dd-trace/src/plugins/util/git-cache')]
    const disabledGitCache = require('../../packages/dd-trace/src/plugins/util/git-cache')

    const firstResult = disabledGitCache.cachedExec('git', GET_COMMIT_MESSAGE_COMMAND_ARGS)
    const firstResultStr = firstResult.toString().trim()
    expect(firstResultStr).to.equal(FIXED_COMMIT_MESSAGE)

    const cacheKey = disabledGitCache.getCacheKey('git', GET_COMMIT_MESSAGE_COMMAND_ARGS)
    const cacheFilePath = disabledGitCache.getCacheFilePath(cacheKey)
    expect(fs.existsSync(cacheFilePath)).to.be.false

    removeGitFromPath()

    let secondError
    try {
      disabledGitCache.cachedExec('git', GET_COMMIT_MESSAGE_COMMAND_ARGS)
    } catch (error) {
      secondError = error
    }

    expect(secondError).to.be.an('error')
    expect(secondError.code).to.equal('ENOENT')
    expect(secondError.message).to.include('git')
  })

  context('invalid DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_DIR', () => {
    function runInvalidCacheTest (invalidCacheDir) {
      process.env.DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_DIR = invalidCacheDir

      delete require.cache[require.resolve('../../packages/dd-trace/src/plugins/util/git-cache')]
      const invalidDirGitCache = require('../../packages/dd-trace/src/plugins/util/git-cache')

      const firstResult = invalidDirGitCache.cachedExec('git', GET_COMMIT_MESSAGE_COMMAND_ARGS)
      const firstResultStr = firstResult.toString().trim()
      expect(firstResultStr).to.equal(FIXED_COMMIT_MESSAGE)

      const cacheKey = invalidDirGitCache.getCacheKey('git', GET_COMMIT_MESSAGE_COMMAND_ARGS)
      const cacheFilePath = invalidDirGitCache.getCacheFilePath(cacheKey)
      expect(fs.existsSync(cacheFilePath)).to.be.false

      removeGitFromPath()

      let secondError
      try {
        invalidDirGitCache.cachedExec('git', GET_COMMIT_MESSAGE_COMMAND_ARGS)
      } catch (error) {
        secondError = error
      }

      expect(secondError).to.be.an('error')
      expect(secondError.code).to.equal('ENOENT')
      expect(secondError.message).to.include('git')
    }

    it('set to a file', () => {
      const filePath = path.join(os.tmpdir(), 'invalid-cache-folder.txt')

      fs.writeFileSync(filePath, 'this is a file, not a directory')
      runInvalidCacheTest(filePath)
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    })

    it('set to a directory without write permissions', () => {
      const tempDir = path.join(os.tmpdir(), 'dd-trace-git-cache-permission-test')

      try {
        fs.mkdirSync(tempDir, { recursive: true })

        // Remove write permissions for the current user (chmod 444 = read-only)
        fs.chmodSync(tempDir, 0o444)

        runInvalidCacheTest(tempDir)
      } finally {
        try {
          fs.chmodSync(tempDir, 0o755)
          if (fs.existsSync(tempDir)) {
            rimraf.sync(tempDir)
          }
        } catch (cleanupError) {
          try {
            rimraf.sync(tempDir)
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    })
  })
})
