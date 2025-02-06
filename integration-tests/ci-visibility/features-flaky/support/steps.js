'use strict'

const assert = require('assert')
const { When, Then } = require('@cucumber/cucumber')

let globalCounter = 0

Then('I should have heard {string}', function (expectedResponse) {
  assert.equal(this.whatIHeard, expectedResponse)
})

When('the greeter says flaky', function () {
  // It's important that the first time this fails. The reason is the following:
  // In `getWrappedRunTestCase` we were returning the first result from
  // `runTestCaseFunction`, so if the first time it passed, the EFD logic was
  // not kicking in. By making it fail, `runTestCaseResult` is false (fail),
  // and the EFD logic is tested correctly, i.e. the test passes as long as a single
  // attempt has passed.
  this.whatIHeard = globalCounter++ % 2 === 1 ? 'flaky' : 'not flaky'
})
