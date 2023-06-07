/* eslint-disable */
const { channel } = require('diagnostics_channel')
const tracer = require('dd-trace')

const testStartCh = channel('dd-trace:ci:manual:test:start')
const testFinishCh = channel('dd-trace:ci:manual:test:finish')
const rootDir = process.cwd()
const testSuite = __dirname

describe('can run tests', () => {
  beforeEach((testName) => {
    testStartCh.publish({ testName, testSuite, rootDir })
  })
  afterEach((status, error) => {
    testFinishCh.publish({ status, error })
  })
  test('first test will pass', () => {
    const testSpan = tracer.scope().active()
    testSpan.setTag('test.custom.tag', 'custom.value')
    assert.equal(1, 1)
  })
  test('second test will fail', () => {
    assert.equal(1, 2)
  })
})
