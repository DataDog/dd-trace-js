'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('tap').mocha

require('./setup/core')

const requirePackageJson = require('../src/require-package-json')
const packageJson = require('../../../package.json')

describe('requirePackageJson', () => {
  it('should read absolute path', () => {
    const { version } = requirePackageJson(process.cwd(), module)
    assert.notStrictEqual(version, null)
    assert.notStrictEqual(version, undefined)
    assert.strictEqual(version, packageJson.version)
  })

  it('should read module.paths when path is relative', () => {
    const { version } = requirePackageJson('../../../', module)
    assert.notStrictEqual(version, null)
    assert.notStrictEqual(version, undefined)
    assert.strictEqual(version, packageJson.version)
  })
})
