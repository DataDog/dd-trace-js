'use strict'

const assert = require('node:assert/strict')

const { isInternalOnly } = require('./change-context')

describe('release change context', () => {
  it('recognizes internal-only file sets conservatively', () => {
    assert.strictEqual(isInternalOnly([
      '.github/workflows/release.yml',
      'packages/dd-trace/test/index.spec.js',
      'integration-tests/http/index.js',
      'yarn.lock',
    ]), true)
    assert.strictEqual(isInternalOnly([
      'packages/dd-trace/src/index.js',
      'packages/dd-trace/test/index.spec.js',
    ]), false)
    assert.strictEqual(isInternalOnly([]), false)
  })
})
