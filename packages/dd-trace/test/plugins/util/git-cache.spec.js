'use strict'

const { expect } = require('chai')
const { describe, it, afterEach, beforeEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const path = require('path')
const os = require('os')

require('../../setup/core')

describe('git-cache', () => {
  let execFileSyncStub
  let fsStub
  let logStub
  let gitCache

  beforeEach(() => {
    delete process.env.DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_ENABLED
    delete process.env.DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_DIR

    execFileSyncStub = sinon.stub()
    fsStub = {
      existsSync: sinon.stub(),
      mkdirSync: sinon.stub(),
      readFileSync: sinon.stub(),
      writeFileSync: sinon.stub()
    }
    logStub = {
      error: sinon.stub()
    }
  })

  afterEach(() => {
    delete process.env.DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_ENABLED
    delete process.env.DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_DIR

    sinon.restore()
  })

  describe('when DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_ENABLED is not set', () => {
    beforeEach(() => {
      gitCache = proxyquire('../../../src/plugins/util/git-cache', {
        child_process: {
          execFileSync: execFileSyncStub
        },
        fs: fsStub,
        '../../log': logStub
      })
    })

    it('should not use cache and call execFileSync directly', () => {
      const expectedResult = 'git output'
      execFileSyncStub.returns(expectedResult)

      const result = gitCache.cachedExec('git', ['status'])

      expect(result).to.equal(expectedResult)
      sinon.assert.calledWith(execFileSyncStub, 'git', ['status'], { stdio: 'pipe' })
      sinon.assert.notCalled(fsStub.existsSync)
      sinon.assert.notCalled(fsStub.readFileSync)
      sinon.assert.notCalled(fsStub.writeFileSync)
    })

    it('should throw errors directly without caching', () => {
      const expectedError = new Error('git command failed')
      expectedError.code = 'ENOENT'
      expectedError.status = 1
      expectedError.errno = -2
      execFileSyncStub.throws(expectedError)

      expect(() => {
        gitCache.cachedExec('git', ['status'])
      }).to.throw(expectedError)

      sinon.assert.calledWith(execFileSyncStub, 'git', ['status'], { stdio: 'pipe' })
      sinon.assert.notCalled(fsStub.writeFileSync)
    })
  })

  describe('when DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_ENABLED is set to "true"', () => {
    beforeEach(() => {
      process.env.DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_ENABLED = 'true'
      gitCache = proxyquire('../../../src/plugins/util/git-cache', {
        child_process: {
          execFileSync: execFileSyncStub
        },
        fs: fsStub,
        '../../log': logStub
      })
    })

    it('should use cache when command succeeds', () => {
      const expectedResult = 'git output'
      const cacheDir = path.join(os.tmpdir(), 'dd-trace-git-cache')
      const cacheKey = gitCache.getCacheKey('git', ['status'])
      const cacheFilePath = path.join(cacheDir, `${cacheKey}.cache`)

      // First call - cache miss
      fsStub.existsSync.withArgs(cacheFilePath).returns(false)
      execFileSyncStub.returns(expectedResult)
      fsStub.existsSync.withArgs(cacheDir).returns(true)

      const result1 = gitCache.cachedExec('git', ['status'])

      expect(result1).to.equal(expectedResult)
      sinon.assert.calledWith(execFileSyncStub, 'git', ['status'], { stdio: 'pipe' })
      sinon.assert.calledWith(fsStub.writeFileSync, cacheFilePath, expectedResult, 'utf8')

      // Reset stubs for second call
      execFileSyncStub.reset()
      fsStub.writeFileSync.reset()

      // Second call - cache hit
      fsStub.existsSync.withArgs(cacheFilePath).returns(true)
      fsStub.readFileSync.withArgs(cacheFilePath, 'utf8').returns(expectedResult)

      const result2 = gitCache.cachedExec('git', ['status'])

      expect(result2).to.equal(expectedResult)
      sinon.assert.notCalled(execFileSyncStub)
      sinon.assert.calledWith(fsStub.readFileSync, cacheFilePath, 'utf8')
    })

    it('should cache and throw errors with same shape', () => {
      const originalError = new Error('git command failed')
      originalError.code = 'ENOENT'
      originalError.status = 1
      originalError.errno = -2

      const cacheDir = path.join(os.tmpdir(), 'dd-trace-git-cache')
      const cacheKey = gitCache.getCacheKey('git', ['status'])
      const cacheFilePath = path.join(cacheDir, `${cacheKey}.cache`)

      // First call - cache miss, command fails
      fsStub.existsSync.withArgs(cacheFilePath).returns(false)
      execFileSyncStub.throws(originalError)
      fsStub.existsSync.withArgs(cacheDir).returns(true)

      expect(() => {
        gitCache.cachedExec('git', ['status'])
      }).to.throw(originalError)

      sinon.assert.calledWith(execFileSyncStub, 'git', ['status'], { stdio: 'pipe' })
      sinon.assert.calledWith(fsStub.writeFileSync,
        cacheFilePath,
        sinon.match(/^__GIT_COMMAND_FAILED__/)
      )

      // Reset stubs for second call
      execFileSyncStub.reset()
      fsStub.writeFileSync.reset()

      // Second call - cache hit, should throw same error
      fsStub.existsSync.withArgs(cacheFilePath).returns(true)
      const cachedErrorData = '__GIT_COMMAND_FAILED__' + JSON.stringify({
        code: originalError.code,
        status: originalError.status,
        errno: originalError.errno,
        message: originalError.message
      })
      fsStub.readFileSync.withArgs(cacheFilePath, 'utf8').returns(cachedErrorData)

      expect(() => {
        gitCache.cachedExec('git', ['status'])
      }).to.throw().and.satisfy((error) => {
        return error.message === originalError.message &&
               error.code === originalError.code &&
               error.status === originalError.status &&
               error.errno === originalError.errno
      })

      sinon.assert.notCalled(execFileSyncStub)
      sinon.assert.calledWith(fsStub.readFileSync, cacheFilePath, 'utf8')
    })

    it('should throw generic error when cached error data is malformed', () => {
      const cacheDir = path.join(os.tmpdir(), 'dd-trace-git-cache')
      const cacheKey = gitCache.getCacheKey('git', ['status'])
      const cacheFilePath = path.join(cacheDir, `${cacheKey}.cache`)

      // Cache hit with malformed error data
      fsStub.existsSync.withArgs(cacheFilePath).returns(true)
      fsStub.readFileSync.withArgs(cacheFilePath, 'utf8').returns('__GIT_COMMAND_FAILED__invalid-json')

      expect(() => {
        gitCache.cachedExec('git', ['status'])
      }).to.throw('Git command failed')

      sinon.assert.notCalled(execFileSyncStub)
    })

    it('should create cache directory if it does not exist', () => {
      const cacheDir = path.join(os.tmpdir(), 'dd-trace-git-cache')
      const expectedResult = 'git output'

      fsStub.existsSync.withArgs(cacheDir).returns(false)
      fsStub.existsSync.withArgs(sinon.match(/\.cache$/)).returns(false)
      execFileSyncStub.returns(expectedResult)

      gitCache.cachedExec('git', ['status'])

      sinon.assert.calledWith(fsStub.mkdirSync, cacheDir, { recursive: true })
    })

    it('should handle cache directory creation failure gracefully', () => {
      const cacheDir = path.join(os.tmpdir(), 'dd-trace-git-cache')
      const expectedResult = 'git output'

      // Create a fresh mock for this specific test
      const freshFsStub = {
        existsSync: sinon.stub().withArgs(cacheDir).returns(false),
        mkdirSync: sinon.stub().throws(new Error('Permission denied')),
        readFileSync: sinon.stub(),
        writeFileSync: sinon.stub()
      }

      const freshLogStub = {
        error: sinon.stub()
      }

      const freshExecFileSyncStub = sinon.stub().returns(expectedResult)

      const freshGitCache = proxyquire('../../../src/plugins/util/git-cache', {
        child_process: {
          execFileSync: freshExecFileSyncStub
        },
        fs: freshFsStub,
        '../../log': freshLogStub
      })

      const result = freshGitCache.cachedExec('git', ['status'])

      expect(result).to.equal(expectedResult)
      sinon.assert.calledWith(freshExecFileSyncStub, 'git', ['status'], { stdio: 'pipe' })
      sinon.assert.calledWith(
        freshLogStub.error,
        'Failed to create git cache directory, disabling cache',
        sinon.match.instanceOf(Error)
      )
    })
  })

  describe('when DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_DIR is set to invalid directory', () => {
    let invalidDirGitCache

    beforeEach(() => {
      process.env.DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_ENABLED = 'true'
      process.env.DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_DIR = '/invalid/path/that/does/not/exist'

      // Create a fresh mock for this test case
      const invalidFsStub = {
        existsSync: sinon.stub().withArgs('/invalid/path/that/does/not/exist').returns(false),
        mkdirSync: sinon.stub().throws(new Error('ENOENT: no such file or directory')),
        readFileSync: sinon.stub(),
        writeFileSync: sinon.stub()
      }

      invalidDirGitCache = proxyquire('../../../src/plugins/util/git-cache', {
        child_process: {
          execFileSync: execFileSyncStub
        },
        fs: invalidFsStub,
        '../../log': logStub
      })
    })

    it('should disable git cache when cache directory is invalid', () => {
      const expectedResult = 'git output'
      execFileSyncStub.returns(expectedResult)

      const result = invalidDirGitCache.cachedExec('git', ['status'])

      expect(result).to.equal(expectedResult)
      sinon.assert.calledWith(execFileSyncStub, 'git', ['status'], { stdio: 'pipe' })
      sinon.assert.calledWith(logStub.error,
        'Failed to create git cache directory, disabling cache',
        sinon.match.instanceOf(Error)
      )
    })
  })
})
