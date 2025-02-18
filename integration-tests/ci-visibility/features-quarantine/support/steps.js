const assert = require('assert')
const { When, Then } = require('@cucumber/cucumber')

Then('I should have heard {string}', function (expectedResponse) {
  assert.equal(this.whatIHeard, 'fail')
})

When('the greeter says quarantine', function () {
  this.whatIHeard = 'quarantine'
})
