require('./setup-fake-test-framework')

function runTests () {
  global.tests.forEach((test) => {
    let testStatus = 'pass'
    let testError = null
    global.beforeEachHooks.forEach(beforeEach => {
      beforeEach(test.description)
    })
    try {
      test.fn()
    } catch (e) {
      testError = e
      testStatus = 'fail'
    }
    global.afterEachHooks.forEach(afterEach => {
      afterEach(testStatus, testError)
    })
  })
}

runTests()
