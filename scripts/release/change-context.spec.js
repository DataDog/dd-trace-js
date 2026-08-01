'use strict'

const assert = require('node:assert/strict')

const { getReleaseNoteContextError, isInternalOnly } = require('./change-context')

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

  it('rejects public release-note types for internal-only changes', () => {
    const files = ['packages/dd-trace/test/index.spec.js']

    for (const type of ['feat', 'fix', 'perf', 'docs']) {
      assert.strictEqual(
        getReleaseNoteContextError(type, files),
        `PR title type "${type}" is public, but every changed file is internal. Use test, bench, ci, or chore.`
      )
    }
  })

  it('accepts internal types and changes with a public file', () => {
    const internalFiles = ['packages/dd-trace/test/index.spec.js']
    const mixedFiles = [
      'packages/dd-trace/src/index.js',
      'packages/dd-trace/test/index.spec.js',
    ]

    assert.strictEqual(getReleaseNoteContextError('test', internalFiles), undefined)
    assert.strictEqual(getReleaseNoteContextError('fix', mixedFiles), undefined)
    assert.strictEqual(getReleaseNoteContextError('fix', []), undefined)
    assert.strictEqual(getReleaseNoteContextError(undefined, internalFiles), undefined)
  })
})
