'use strict'

const assert = require('assert')
const { When, Then } = require('@cucumber/cucumber')

Then('I should have heard {string}', function (expectedResponse) {
  assert.equal(this.whatIHeard, expectedResponse)
})

When('the greeter says disabled parallel', function () {
  // eslint-disable-next-line no-console
  console.log('I am running disabled parallel')
  // expected to fail if not disabled
  this.whatIHeard = 'disabld parallel'
})

When('the greeter says passing parallel', function () {
  this.whatIHeard = 'passing parallel'
})

When('the greeter says quarantine parallel', function () {
  // eslint-disable-next-line no-console
  console.log('I am running quarantine parallel')
  // Will always fail the Then step — quarantined tests should not affect exit code
  this.whatIHeard = 'quarantine parallel'
})
