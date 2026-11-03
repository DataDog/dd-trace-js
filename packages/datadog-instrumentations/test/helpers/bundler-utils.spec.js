'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('bundler utils', () => {
  describe('isESMFile', () => {
    let isESMFile, readFileSync

    beforeEach(() => {
      isESMFile = require('../../src/helpers/bundler-utils').isESMFile
      readFileSync = sinon.stub(fs, 'readFileSync')
      readFileSync.callsFake(function () {
        throw new Error('File does not exist')
      })
    })

    afterEach(() => {
      readFileSync.restore()
    })

    it('should return true if the file has a .mjs extension', () => {
      assert.strictEqual(isESMFile('/path/to/test.mjs'), true)
    })

    it('should return false if the file has a .cjs extension', () => {
      assert.strictEqual(isESMFile('/path/to/test.cjs'), false)
    })

    it('should return true if the file has a .mts extension in a CommonJS package', () => {
      assert.strictEqual(isESMFile('/path/to/test.mts', '/path/to/package.json', { type: 'commonjs' }), true)
    })

    it('should return false if the file has a .cts extension in an ESM package', () => {
      assert.strictEqual(isESMFile('/path/to/test.cts', '/path/to/package.json', { type: 'module' }), false)
    })

    it('should return true if the file is in a directory with a package.json that has a type of module', () => {
      assert.strictEqual(isESMFile('/path/to/test.js', '/path/to/package.json', { type: 'module' }), true)
    })

    it('should return false if the file is in a directory with a package.json that has a type of commonjs', () => {
      assert.strictEqual(isESMFile('/path/to/test.js', '/path/to/package.json', { type: 'commonjs' }), false)
    })

    it('should return false if the file is in a directory with a package.json without a type', () => {
      assert.strictEqual(isESMFile('/path/to/test.js', '/path/to/package.json', {}), false)
    })

    it('should return true if the file has a package.json before the main with type module', () => {
      readFileSync.callsFake(function (filename) {
        if (filename === '/path/to/deeper/package.json') {
          return JSON.stringify({ type: 'module' })
        }

        throw new Error('File does not exist')
      })

      assert.strictEqual(isESMFile('/path/to/deeper/test.js', '/path/to/package.json', { type: 'commonjs' }), true)
    })

    it('should return false if the file has a package.json before the main with type commonjs', () => {
      readFileSync.callsFake(function (filename) {
        if (filename === '/path/to/deeper/package.json') {
          return JSON.stringify({ type: 'commonjs' })
        }

        throw new Error('File does not exist')
      })

      assert.strictEqual(isESMFile('/path/to/deeper/test.js', '/path/to/package.json', { type: 'module' }), false)
    })

    it('should return false if the file has a package.json before the main without any type defined', () => {
      readFileSync.callsFake(function (filename) {
        if (filename === '/path/to/deeper/package.json') {
          return JSON.stringify({})
        }

        throw new Error('File does not exist')
      })

      assert.strictEqual(isESMFile('/path/to/deeper/test.js', '/path/to/package.json', { type: 'module' }), false)
    })
  })

  describe('getGitMetadataBanner', () => {
    const REMOTE_COMMAND = 'git config --get remote.origin.url'
    const SHA_COMMAND = 'git rev-parse HEAD'
    let execSync, getGitMetadataBanner, log

    beforeEach(() => {
      execSync = sinon.stub()
      log = { debug: sinon.spy(), warn: sinon.spy() }
      getGitMetadataBanner = proxyquire('../../src/helpers/bundler-utils', {
        'node:child_process': { execSync },
      }).getGitMetadataBanner
    })

    /**
     * @param {string} banner
     */
    function runBanner (banner) {
      const process = { env: {} }
      // eslint-disable-next-line no-new-func
      new Function('process', banner)(process)
      return process.env
    }

    it('should set the trimmed repository URL and commit SHA of the working directory', () => {
      execSync.withArgs(REMOTE_COMMAND).returns('git@github.com:DataDog/dd-trace-js.git\n')
      execSync.withArgs(SHA_COMMAND).returns('abc123\n')

      const banner = getGitMetadataBanner(log)

      assert.deepStrictEqual(runBanner(banner), {
        DD_GIT_REPOSITORY_URL: 'git@github.com:DataDog/dd-trace-js.git',
        DD_GIT_COMMIT_SHA: 'abc123',
      })
      for (const call of execSync.getCalls()) {
        assert.deepStrictEqual(call.args[1], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
          cwd: process.cwd(),
        })
      }
      sinon.assert.calledOnceWithExactly(
        log.debug,
        'Automatically injected git metadata (DD_GIT_REPOSITORY_URL: %s, DD_GIT_COMMIT_SHA: %s)',
        'git@github.com:DataDog/dd-trace-js.git',
        'abc123'
      )
      sinon.assert.notCalled(log.warn)
    })

    it('should escape metadata as string literals', () => {
      const repositoryURL = "https://example.com/it's \"quoted\"\\repo.git"
      execSync.withArgs(REMOTE_COMMAND).returns(repositoryURL)
      execSync.withArgs(SHA_COMMAND).returns('abc123')

      assert.deepStrictEqual(runBanner(getGitMetadataBanner(log)), {
        DD_GIT_REPOSITORY_URL: repositoryURL,
        DD_GIT_COMMIT_SHA: 'abc123',
      })
    })

    it('should not touch an environment that is not an object', () => {
      execSync.withArgs(REMOTE_COMMAND).returns('https://example.com/repo.git')
      execSync.withArgs(SHA_COMMAND).returns('abc123')
      const banner = getGitMetadataBanner(log)

      // eslint-disable-next-line no-new-func
      new Function('process', banner)({ env: null })
      // eslint-disable-next-line no-new-func
      new Function('process', banner)(null)
    })

    it('should warn and set only the commit SHA when the repository URL lookup fails', () => {
      execSync.withArgs(REMOTE_COMMAND).throws(new Error('no remote'))
      execSync.withArgs(SHA_COMMAND).returns('abc123\n')

      assert.deepStrictEqual(runBanner(getGitMetadataBanner(log)), { DD_GIT_COMMIT_SHA: 'abc123' })
      sinon.assert.calledOnceWithExactly(log.warn, 'failed to get git repository URL:', 'no remote')
      sinon.assert.calledWith(log.debug, sinon.match.string, 'not available', 'abc123')
    })

    it('should warn and set only the repository URL when the commit SHA lookup fails', () => {
      execSync.withArgs(REMOTE_COMMAND).returns('https://example.com/repo.git\n')
      execSync.withArgs(SHA_COMMAND).throws(new Error('not a git repository'))

      assert.deepStrictEqual(runBanner(getGitMetadataBanner(log)), {
        DD_GIT_REPOSITORY_URL: 'https://example.com/repo.git',
      })
      sinon.assert.calledOnceWithExactly(log.warn, 'failed to get git commit SHA:', 'not a git repository')
      sinon.assert.calledWith(log.debug, sinon.match.string, 'https://example.com/repo.git', 'not available')
    })

    it('should return an empty banner when no git metadata is available', () => {
      execSync.throws(new Error('git is not installed'))

      assert.strictEqual(getGitMetadataBanner(log), '')
      sinon.assert.calledWith(log.warn, 'No git metadata available - skipping injection')
      sinon.assert.callCount(log.warn, 3)
      sinon.assert.notCalled(log.debug)
    })
  })
})
