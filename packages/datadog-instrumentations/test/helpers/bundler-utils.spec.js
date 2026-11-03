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

  describe('getGitMetadata', () => {
    let execSync, getGitMetadata, log

    beforeEach(() => {
      execSync = sinon.stub()
      log = { warn: sinon.spy() }
      getGitMetadata = proxyquire('../../src/helpers/bundler-utils', {
        'node:child_process': { execSync },
      }).getGitMetadata
    })

    it('should return the trimmed repository URL and commit SHA of the working directory', () => {
      execSync.withArgs('git config --get remote.origin.url').returns('git@github.com:DataDog/dd-trace-js.git\n')
      execSync.withArgs('git rev-parse HEAD').returns('abc123\n')

      assert.deepStrictEqual(getGitMetadata(log), {
        repositoryURL: 'git@github.com:DataDog/dd-trace-js.git',
        commitSHA: 'abc123',
      })
      for (const call of execSync.getCalls()) {
        assert.deepStrictEqual(call.args[1], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
          cwd: process.cwd(),
        })
      }
      sinon.assert.notCalled(log.warn)
    })

    it('should warn and keep the commit SHA when the repository URL lookup fails', () => {
      execSync.withArgs('git config --get remote.origin.url').throws(new Error('no remote'))
      execSync.withArgs('git rev-parse HEAD').returns('abc123\n')

      assert.deepStrictEqual(getGitMetadata(log), { repositoryURL: null, commitSHA: 'abc123' })
      sinon.assert.calledOnceWithExactly(log.warn, 'failed to get git repository URL:', 'no remote')
    })

    it('should warn and keep the repository URL when the commit SHA lookup fails', () => {
      execSync.withArgs('git config --get remote.origin.url').returns('https://example.com/repo.git\n')
      execSync.withArgs('git rev-parse HEAD').throws(new Error('not a git repository'))

      assert.deepStrictEqual(getGitMetadata(log), { repositoryURL: 'https://example.com/repo.git', commitSHA: null })
      sinon.assert.calledOnceWithExactly(log.warn, 'failed to get git commit SHA:', 'not a git repository')
    })
  })
})
