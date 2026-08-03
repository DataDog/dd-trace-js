'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { createFileSafely } = require('./safe-files')
const { createValidationBlocker } = require('./validation-blocker')

const EXECUTION_LOCK_FILENAME = '.dd-test-optimization-validation.lock'

function getExecutionLockPath (out) {
  return path.join(path.resolve(out), EXECUTION_LOCK_FILENAME)
}

// Locks are never reclaimed automatically; only the creator may release the exact file identity.
function acquireExecutionLock ({ out, approvedPlanSha256 }) {
  const lockPath = getExecutionLockPath(out)
  const content = `${JSON.stringify({
    approvedPlanSha256,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`
  try {
    createFileSafely(out, lockPath, content, 'validation execution lock')
  } catch (error) {
    if (error.code === 'EEXIST') throw getExistingLockError(lockPath)
    throw error
  }

  const stat = fs.lstatSync(lockPath, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Validation execution lock is not a regular file: ${lockPath}`)
  }
  return { dev: stat.dev, ino: stat.ino, path: lockPath }
}

function releaseExecutionLock (lock) {
  let stat
  try {
    stat = fs.lstatSync(lock.path, { bigint: true })
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Validation execution lock disappeared before safe cleanup: ${lock.path}`)
    }
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== lock.dev || stat.ino !== lock.ino) {
    throw new Error(`Refusing to remove a changed validation execution lock: ${lock.path}`)
  }
  fs.unlinkSync(lock.path)
}

function getExistingLockError (lockPath) {
  return createValidationBlocker(
    `Another validation may be active, or an interrupted run left its execution lock: ${lockPath}.`,
    {
      kind: 'execution-lock-exists',
      recommendation: `Inspect ${lockPath}. Remove only that lock after confirming no validation process is active, ` +
        'then render and approve a fresh plan.',
      suppressReport: true,
    }
  )
}

module.exports = {
  EXECUTION_LOCK_FILENAME,
  acquireExecutionLock,
  getExecutionLockPath,
  releaseExecutionLock,
}
