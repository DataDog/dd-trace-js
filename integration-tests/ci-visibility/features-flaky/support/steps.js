const assert = require('assert')
const { When, Then } = require('@cucumber/cucumber')

let globalCounter = 0

Then('I should have heard {string}', function (expectedResponse) {
  assert.equal(this.whatIHeard, expectedResponse)
})

When('the greeter says flaky', function () {
  this.whatIHeard = globalCounter++ % 2 === 0 ? 'flaky' : 'not flaky'
})
