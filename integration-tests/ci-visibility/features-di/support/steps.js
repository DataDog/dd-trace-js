'use strict'

const assert = require('assert')
const { When, Then } = require('@cucumber/cucumber')
const sum = require('./sum')

let count = 0

When('the greeter says hello', function () {
  this.whatIHeard = 'hello'
})

Then('I should have heard {string}', function (expectedResponse) {
  sum(11, 3)
  assert.equal(this.whatIHeard, expectedResponse)
})

Then('I should have flakily heard {string}', function (expectedResponse) {
  const shouldFail = count++ < 1
  if (shouldFail) {
    sum(11, 3)
  } else {
    sum(1, 3) // does not hit the breakpoint the second time
  }
  assert.equal(this.whatIHeard, expectedResponse)
})
