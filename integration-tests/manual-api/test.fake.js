/* eslint-disable */
const { channel } = require('diagnostics_channel')

const testStartCh = channel('ci:manual:test:start')
const testFinishCh = channel('ci:manual:test:finish')

describe('can run tests', () => {
  beforeEach((testName) => {
    testStartCh.publish({ testName, testSuite: 'test.fake.js' })
  })
  afterEach((testName) => {
    testFinishCh.publish({ testName, status: 'pass' })
  })
  test('first', () => {
    console.log('run first test')
  })
  test('second', () => {
    console.log('run second test')
  })
})
