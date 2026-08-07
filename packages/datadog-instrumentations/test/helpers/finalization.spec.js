'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('packages/datadog-instrumentations/src/helpers/finalization.js', () => {
  for (const [description, finalize, expectedFinalizationError] of [
    ['finalization succeeds', () => Promise.resolve(), undefined],
    ['finalization throws', () => { throw new Error('synchronous finalization failure') },
      /synchronous finalization failure/],
    ['finalization rejects', () => Promise.reject(new Error('asynchronous finalization failure')),
      /asynchronous finalization failure/],
  ]) {
    it(`preserves the original framework error when ${description}`, async () => {
      const log = { error: sinon.spy() }
      const { finalizeAndRethrow } = proxyquire('../../src/helpers/finalization', {
        '../../../dd-trace/src/log': log,
      })
      const frameworkError = new Error('framework failure')

      await assert.rejects(finalizeAndRethrow(frameworkError, finalize, 'Framework'), error => {
        assert.strictEqual(error, frameworkError)
        return true
      })

      if (expectedFinalizationError) {
        sinon.assert.calledOnce(log.error)
        assert.match(log.error.firstCall.args[2].message, expectedFinalizationError)
      } else {
        sinon.assert.notCalled(log.error)
      }
    })
  }
})
