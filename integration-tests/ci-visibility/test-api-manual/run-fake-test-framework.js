'use strict'

/* eslint-disable */

function runTests () {
  const promises = global.tests.map(async (test) => {
    let testStatus = 'pass'
    let testError = null
    global.beforeEachHooks.forEach(beforeEach => {
      beforeEach(test.description)
    })
    try {
      await test.fn()
      console.log(`✓ ${test.description}`)
    } catch (e) {
      testError = e
      testStatus = 'fail'
      console.log(`x ${test.description}: ${e}`)
    }
    global.afterEachHooks.forEach(afterEach => {
      afterEach(testStatus, testError)
    })
  })
  return Promise.all(promises)
}

runTests()
