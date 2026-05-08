'use strict'

const assert = require('assert')
const { When, Then, Before, After } = require('@cucumber/cucumber')

let flakyCounter = 0
let flakyWithHooksCounter = 0

Before('@skip', function () {
  return 'skipped'
})

Before('@with-hooks', function () {
  this.hookRan = true
})

After('@with-hooks', function () {
  // hook ran after scenario
})

Then('I should have heard {string}', function (expectedResponse) {
  assert.equal(this.whatIHeard, expectedResponse)
})

When('the greeter says pass', function () {
  this.whatIHeard = 'pass'
})

When('the greeter says fail', function () {
  throw new Error('This test always fails')
})

When('the greeter says flaky', function () {
  if (++flakyCounter < 3) {
    throw new Error('Not good enough!')
  }
  this.whatIHeard = 'flaky'
})

When('the greeter says flaky with hooks', function () {
  if (++flakyWithHooksCounter < 3) {
    throw new Error('Not good enough!')
  }
  this.whatIHeard = 'flaky'
})
