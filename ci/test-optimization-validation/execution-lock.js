'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { createFileSafely } = require('./safe-files')
const { createValidationBlocker } = require('./validation-blocker')

const EXECUTION_LOCK_FILENAME = '.dd-test-optimization-validation.lock'

/**
 * Returns the fixed single-flight lock path for one result directory.
 *
 * @param {string} out validation result directory
 * @returns {string} lock path
 */
function getExecutionLockPath (out) {
  return path.join(path.resolve(out), EXECUTION_LOCK_FILENAME)
}

/**
 * Refuses plan generation while a prior execution lock remains.
 *
 * @param {string} out validation result directory
 * @returns {void}
 */
function assertNoExecutionLock (out) {
  const lockPath = getExecutionLockPath(out)
  try {
    fs.lstatSync(lockPath)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw getExistingLockError(lockPath)
}

/**
 * Acquires a non-reclaiming single-flight lock for live validation.
 *
 * @param {object} input lock inputs
 * @param {string} input.out validation result directory
 * @param {string} input.approvedPlanSha256 approved plan digest
 * @returns {{dev: number, ino: number, path: string}} lock identity
 */
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

  const stat = fs.lstatSync(lockPath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Validation execution lock is not a regular file: ${lockPath}`)
  }
  return { dev: stat.dev, ino: stat.ino, path: lockPath }
}

/**
 * Releases only the exact lock file created by this process.
 *
 * @param {{dev: number, ino: number, path: string}} lock lock identity
 * @returns {void}
 */
function releaseExecutionLock (lock) {
  let stat
  try {
    stat = fs.lstatSync(lock.path)
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

/**
 * Builds the fail-closed blocker for an existing lock.
 *
 * @param {string} lockPath existing lock path
 * @returns {Error} typed blocker
 */
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
  assertNoExecutionLock,
  getExecutionLockPath,
  releaseExecutionLock,
}
