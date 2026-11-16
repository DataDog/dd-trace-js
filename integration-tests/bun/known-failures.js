'use strict'

const { relative } = require('node:path')

/**
 * @param {import('mocha').Test} test
 */
function specFile (test) {
  return relative(process.cwd(), test.file).replaceAll('\\', '/')
}

/**
 * Keep the original failure when an asynchronous assertion also causes a later
 * multiple-done error. Stable reasons avoid recording machine-specific paths.
 * @param {Record<string, Record<string, string>>} failures
 * @param {import('mocha').Test} test
 * @param {Error & { code?: string }} error
 */
function collectFailure (failures, test, error) {
  const file = specFile(test)
  let reason = error.message.split('\n')[0].replaceAll(`${process.cwd()}/`, '') || 'test body failed under Bun'
  if (error.code === 'ERR_MOCHA_TIMEOUT') reason = 'test timed out under Bun'
  if (error.code === 'ERR_ASSERTION') reason = 'test assertion failed under Bun'
  failures[file] ??= {}
  failures[file][test.fullTitle()] ??= reason
}

/**
 * Wrap the runnable's completion, not its body, so sync, callback, promise and timeout
 * failures share Mocha's normal cleanup path. Suite/setup/teardown failures are never inverted.
 * @param {Record<string, Record<string, string>>} failures
 * @returns {import('mocha').RootHookObject}
 */
function knownFailureHooks (failures) {
  return {
    beforeEach () {
      const test = this.currentTest
      const file = specFile(test)
      const title = test.fullTitle()
      const reason = failures[file]?.[title]
      if (!reason) return

      const run = test.run
      test.run = function (done) {
        return run.call(this, error => {
          if (test.pending) return done(error)
          if (error) {
            test.pending = true
            test.title += ` [known Bun failure: ${reason}]`
            return done()
          }
          done(new Error(`Known Bun failure unexpectedly passed. Remove ${file}: ${title} from known-failures.json`))
        })
      }
    },
  }
}

module.exports = { collectFailure, knownFailureHooks, specFile }
module.exports.mochaHooks = process.env.DD_TEST_RUNTIME === 'bun' && !process.env.DD_BUN_GENERATE_FAILURES
  ? knownFailureHooks(require('./known-failures.json'))
  : {}
