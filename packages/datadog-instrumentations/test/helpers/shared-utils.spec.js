'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const {
  isBuiltinModuleName,
  isNodeBuiltinModuleName,
  normalizeModuleName,
} = require('../../src/helpers/shared-utils')

describe('shared-utils', () => {
  describe('isNodeBuiltinModuleName', () => {
    it('accepts builtins with and without the node: prefix', () => {
      assert.strictEqual(isNodeBuiltinModuleName('url'), true)
      assert.strictEqual(isNodeBuiltinModuleName('node:url'), true)
      assert.strictEqual(isNodeBuiltinModuleName('dns/promises'), true)
    })

    it('rejects electron, which Node does not resolve as a builtin', () => {
      assert.strictEqual(isNodeBuiltinModuleName('electron'), false)
    })

    it('rejects packages and paths that merely look builtin', () => {
      assert.strictEqual(isNodeBuiltinModuleName('express'), false)
      assert.strictEqual(isNodeBuiltinModuleName('node:express'), false)
      assert.strictEqual(isNodeBuiltinModuleName('url-parse'), false)
      assert.strictEqual(isNodeBuiltinModuleName('/app/node_modules/url/index.js'), false)
    })
  })

  describe('isBuiltinModuleName', () => {
    it('accepts electron, which a packaged binary resolves without a package directory', () => {
      assert.strictEqual(isBuiltinModuleName('electron'), true)
      assert.strictEqual(isBuiltinModuleName('url'), true)
      assert.strictEqual(isBuiltinModuleName('express'), false)
    })
  })

  describe('normalizeModuleName', () => {
    it('strips the node: prefix from a builtin', () => {
      assert.strictEqual(normalizeModuleName('node:url'), 'url')
      assert.strictEqual(normalizeModuleName('url'), 'url')
    })

    it('keeps a name that is not a prefixable builtin', () => {
      assert.strictEqual(normalizeModuleName('electron'), 'electron')
      assert.strictEqual(normalizeModuleName('node:express'), 'node:express')
    })
  })
})
