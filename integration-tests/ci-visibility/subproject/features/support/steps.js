'use strict'

const assert = require('assert')
const { When, Then } = require('@cucumber/cucumber')
class Greeter {
  sayGreetings () {
    return 'greetings'
  }
}

When('the greeter says greetings', function () {
  this.whatIHeard = new Greeter().sayGreetings()
})

Then('I should have heard {string}', function (expectedResponse) {
  assert.equal(this.whatIHeard, expectedResponse)
})
