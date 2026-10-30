'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

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
})
