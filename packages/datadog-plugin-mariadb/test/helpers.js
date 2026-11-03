'use strict'

const { performance } = require('node:perf_hooks')

const sinon = require('sinon')

/**
 * @param {number} start
 * @param {(advanceTo: (value: number) => void) => Promise<unknown>} run
 * @returns {Promise<void>}
 */
async function withFakeNow (start, run) {
  const nowStub = sinon.stub(performance, 'now').returns(start)

  try {
    await run(value => nowStub.returns(value))
  } finally {
    nowStub.restore()
  }
}

/**
 * Runs an operation and verifies that it does not read the clock before returning.
 *
 * @template T
 * @param {() => T} run
 * @returns {T}
 */
function withoutImmediateClockRead (run) {
  const nowStub = sinon.stub(performance, 'now').returns(100)

  try {
    const result = run()
    sinon.assert.notCalled(nowStub)
    return result
  } finally {
    nowStub.restore()
  }
}

module.exports = { withFakeNow, withoutImmediateClockRead }
