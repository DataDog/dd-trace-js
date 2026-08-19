'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const proxyquire = require('proxyquire').noPreserveCache()

const {
  acquireExecutionLock,
  getExecutionLockPath,
  releaseExecutionLock,
} = require('../../../../ci/test-optimization-validation/execution-lock')
const { createWindowsFileReferenceFs } = require('./validation-test-helpers')

describe('test optimization validation execution lock', () => {
  let out
  let root

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-lock-'))
    out = path.join(root, 'results')
    fs.mkdirSync(out)
  })

  afterEach(() => fs.rmSync(root, { force: true, recursive: true }))

  it('rejects a duplicate execution without reclaiming its lock', () => {
    const lock = acquireExecutionLock({
      out,
      approvedPlanSha256: 'a'.repeat(64),
    })
    const lockPath = getExecutionLockPath(out)
    const original = fs.readFileSync(lockPath)

    assert.throws(
      () => acquireExecutionLock({ out, approvedPlanSha256: 'a'.repeat(64) }),
      error => {
        assert.strictEqual(error.validationExitCode, 2)
        assert.strictEqual(error.suppressReport, true)
        assert.strictEqual(error.validationBlocker.kind, 'execution-lock-exists')
        assert.match(error.validationBlocker.recommendation, /confirming no validation process is active/)
        return true
      }
    )
    assert.deepStrictEqual(fs.readFileSync(lockPath), original)

    releaseExecutionLock(lock)
    assert.strictEqual(fs.existsSync(lockPath), false)
  })

  it('refuses to remove a replacement at the approved lock path', () => {
    const lock = acquireExecutionLock({
      out,
      approvedPlanSha256: 'b'.repeat(64),
    })
    fs.unlinkSync(lock.path)
    fs.mkdirSync(lock.path)

    assert.throws(() => releaseExecutionLock(lock), /changed validation execution lock/)
    assert.strictEqual(fs.statSync(lock.path).isDirectory(), true)
  })

  it('compares lock identities without rounding large file reference numbers', () => {
    const windowsLock = proxyquire('../../../../ci/test-optimization-validation/execution-lock', {
      'node:fs': createWindowsFileReferenceFs(),
    })
    const lock = windowsLock.acquireExecutionLock({
      out,
      approvedPlanSha256: 'c'.repeat(64),
    })
    const replacement = path.join(out, 'replacement.lock')
    fs.writeFileSync(replacement, 'replacement\n')
    fs.unlinkSync(lock.path)
    fs.renameSync(replacement, lock.path)

    assert.strictEqual(typeof lock.ino, 'bigint')
    assert.throws(() => windowsLock.releaseExecutionLock(lock), /changed validation execution lock/)
    assert.strictEqual(fs.readFileSync(lock.path, 'utf8'), 'replacement\n')
  })
})
