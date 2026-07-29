'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  acquireExecutionLock,
  assertNoExecutionLock,
  getExecutionLockPath,
  releaseExecutionLock,
} = require('../../../../ci/test-optimization-validation/execution-lock')

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
    assert.throws(() => assertNoExecutionLock(out), /Another validation may be active/)
    assert.deepStrictEqual(fs.readFileSync(lockPath), original)

    releaseExecutionLock(lock)
    assert.strictEqual(fs.existsSync(lockPath), false)
    assertNoExecutionLock(out)
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
})
