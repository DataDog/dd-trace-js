const assert = require('assert')
const { When, Then } = require('@cucumber/cucumber')

Then('I should have heard {string}', function (expectedResponse) {
  if (this.whatIHeard === 'quarantine') {
    assert.equal(this.whatIHeard, 'fail')
  } else {
    assert.equal(this.whatIHeard, expectedResponse)
  }
})

When('the greeter says quarantine', function () {
  // eslint-disable-next-line no-console
  console.log('I am running as quarantine') // just to assert whether this is running
  this.whatIHeard = 'quarantine'
})

When('the greeter says disabled', function () {
  // eslint-disable-next-line no-console
  console.log('I am running') // just to assert whether this is running
  // expected to fail if not disabled
  this.whatIHeard = 'disabld'
})
