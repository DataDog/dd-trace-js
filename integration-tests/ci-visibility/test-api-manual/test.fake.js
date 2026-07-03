/* eslint-disable */
const { channel } = require('dc-polyfill')
const tracer = require('dd-trace')

const assert = require('assert/strict')

const testAddTagsCh = channel('dd-trace:ci:manual:test:addTags')
const testSuite = __filename
global.testSuite = testSuite

function assertActiveTestSpan () {
  if (process.env.DD_CIVISIBILITY_MANUAL_API_ENABLED === 'false') return
  assert.equal(tracer.scope().active().context()._name, 'test-api-manual.test')
}

describe('can run tests', () => {
  test('first test will pass', () => {
    assertActiveTestSpan()
    testAddTagsCh.publish({ 'test.custom.tag': 'custom.value' })
    assert.equal(1, 1)
  })
  test('second test will fail', () => {
    assertActiveTestSpan()
    assert.equal(1, 2)
  })
  test('async test will pass', () => {
    assertActiveTestSpan()
    return /** @type {Promise<void>} */ (new Promise((resolve) => {
      setTimeout(() => {
        assertActiveTestSpan()
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
    assert.equal(testSpan.context()._name, 'test-api-manual.test')
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
