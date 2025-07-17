'use strict'

const assert = require('assert')
const { When, Then } = require('@cucumber/cucumber')

Then('I should have heard {string}', function (expectedResponse) {
  assert.equal(this.whatIHeard, expectedResponse)
})

When('the greeter says impacted test', function () {
  this.whatIHeard = 'impacted test'
})
