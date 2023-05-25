require('./setup-fake-test-framework')

function runTests () {
  global.tests.forEach((test) => {
    global.beforeEachHooks.forEach(beforeEach => {
      beforeEach(test.description)
    })
    test.fn()
    global.afterEachHooks.forEach(afterEach => {
      afterEach(test.description)
    })
  })
}

runTests()
