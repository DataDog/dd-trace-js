'use strict'

const { relative } = require('node:path')
const { isDeepStrictEqual, stripVTControlCharacters } = require('node:util')

/**
 * @typedef {{ name: string, code: string, message: string }} FailureSignature
 * @typedef {{ reason: string, signature: FailureSignature }} KnownFailure
 */

/**
 * @param {Error & { code?: string }} error
 * @returns {FailureSignature}
 */
function failureSignature (error) {
  return {
    name: error.name,
    code: error.code ?? '',
    message: stripVTControlCharacters(error.message).replaceAll(process.cwd(), '<root>'),
  }
}

/**
 * @param {import('mocha').Test} test
 */
function specFile (test) {
  return relative(process.cwd(), test.file).replaceAll('\\', '/')
}

/**
 * Keep the original failure when an asynchronous assertion also causes a later
 * multiple-done error. Stable reasons avoid recording machine-specific paths.
 * @param {Record<string, Record<string, KnownFailure>>} failures
 * @param {import('mocha').Test} test
 * @param {Error & { code?: string }} error
 */
function collectFailure (failures, test, error) {
  const file = specFile(test)
  let reason = error.message.split('\n')[0].replaceAll(`${process.cwd()}/`, '') || 'test body failed under Bun'
  if (error.code === 'ERR_MOCHA_TIMEOUT') reason = 'test timed out under Bun'
  if (error.code === 'ERR_ASSERTION') reason = 'test assertion failed under Bun'
  failures[file] ??= {}
  failures[file][test.fullTitle()] ??= { reason, signature: failureSignature(error) }
}

/**
 * Wrap the runnable's completion, not its body, so sync, callback, promise and timeout
 * failures share Mocha's normal cleanup path. Suite/setup/teardown failures are never inverted.
 * @param {Record<string, Record<string, KnownFailure>>} failures
 * @returns {import('mocha').RootHookObject}
 */
function knownFailureHooks (failures) {
  return {
    beforeEach () {
      const test = this.currentTest
      const file = specFile(test)
      const title = test.fullTitle()
      const expected = failures[file]?.[title]
      if (!expected) return

      const run = test.run
      test.run = function (done) {
        return run.call(this, error => {
          if (test.pending) return done(error)
          if (error) {
            if (!isDeepStrictEqual(failureSignature(error), expected.signature)) return done(error)
            test.pending = true
            test.title += ` [known Bun failure: ${expected.reason}]`
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
