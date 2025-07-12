'use strict'

const assert = require('assert')
const { When, Then } = require('@cucumber/cucumber')

let globalCounter = 0

Then('I should have heard {string}', function (expectedResponse) {
  assert.equal(this.whatIHeard, expectedResponse)
})

When('the greeter says flaky', function () {
  if (++globalCounter < 3) {
    throw new Error('Not good enough!')
  }
  this.whatIHeard = 'flaky'
})
