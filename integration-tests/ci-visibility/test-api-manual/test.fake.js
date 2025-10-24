/* eslint-disable */
const { channel } = require('dc-polyfill')
const tracer = require('dd-trace')

const assert = require('assert/strict')

const testStartCh = channel('dd-trace:ci:manual:test:start')
const testFinishCh = channel('dd-trace:ci:manual:test:finish')
const testAddTagsCh = channel('dd-trace:ci:manual:test:addTags')
const testSuite = __filename

describe('can run tests', () => {
  beforeEach((testName) => {
    testStartCh.publish({ testName, testSuite })
  })
  afterEach((status, error) => {
    testFinishCh.publish({ status, error })
  })
  test('first test will pass', () => {
    testAddTagsCh.publish({ 'test.custom.tag': 'custom.value' })
    assert.equal(1, 1)
  })
  test('second test will fail', () => {
    assert.equal(1, 2)
  })
  test('async test will pass', () => {
    return /** @type {Promise<void>} */ (new Promise((resolve) => {
      setTimeout(() => {
        assert.equal(1, 1)
        resolve()
      }, 10)
    }))
  })
  test('integration test', () => {
    // Just for testing purposes, so we don't create a custom span
    if (process.env.DD_CIVISIBILITY_MANUAL_API_ENABLED === 'false') {
      return Promise.resolve()
    }
    const testSpan = tracer.scope().active()
    const childSpan = tracer.startSpan('custom.span', {
      childOf: testSpan
    })
    return /** @type {Promise<void>} */ (new Promise((resolve) => {
      setTimeout(() => {
        childSpan.finish()
        resolve()
      }, 10)
    }))
  })
})
