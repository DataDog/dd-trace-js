'use strict'

const tracer = require('dd-trace')

const assert = require('node:assert/strict')
const { channel } = require('dc-polyfill')

const testStartCh = channel('dd-trace:ci:manual:test:start')
const testFinishCh = channel('dd-trace:ci:manual:test:finish')
const testSuite = __filename

/**
 * @param {string} testName
 */
function startManualTest (testName) {
  testStartCh.publish({ testName, testSuite })
}

/**
 * @param {string} status
 * @param {Error} [error]
 */
function finishManualTest (status, error) {
  testFinishCh.publish({ status, error })
  assert.strictEqual(tracer.scope().active(), null)
}

describe('manual test context restoration', () => {
  beforeEach(startManualTest)

  afterEach(finishManualTest)

  test('restores the previous active span', () => {
    const outerTestSpan = tracer.scope().active()

    testStartCh.publish({ testName: 'nested manual test', testSuite })
    assert.notStrictEqual(tracer.scope().active(), outerTestSpan)

    testFinishCh.publish({ status: 'pass' })
    assert.strictEqual(tracer.scope().active(), outerTestSpan)
  })
})
