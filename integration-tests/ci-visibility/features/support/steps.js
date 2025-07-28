'use strict'

const assert = require('assert')
const { When, Then, Before, After } = require('@cucumber/cucumber')
const tracer = require('dd-trace')

class Greeter {
  sayFarewell () {
    return 'farewell'
  }

  sayGreetings () {
    return 'greetings'
  }

  sayYo () {
    return 'yo'
  }

  sayYeah () {
    return 'yeah whatever'
  }
}

Before('@skip', function () {
  return 'skipped'
})

After(function () {
  tracer.scope().active().addTags({
    'custom_tag.after': 'hello after'
  })
})

Before(function () {
  tracer.scope().active().addTags({
    'custom_tag.before': 'hello before'
  })
})

Then('I should have heard {string}', function (expectedResponse) {
  assert.equal(this.whatIHeard, expectedResponse)
})

When('the greeter says farewell', function () {
  this.whatIHeard = new Greeter().sayFarewell()
})

When('the greeter says yo', function () {
  this.whatIHeard = new Greeter().sayYo()
})

When('the greeter says yeah', function () {
  this.whatIHeard = new Greeter().sayYeah()
})

When('the greeter says greetings', function () {
  tracer.scope().active().addTags({
    'custom_tag.when': 'hello when'
  })
  this.whatIHeard = new Greeter().sayGreetings()
})

When('the greeter says whatever', function () {
  this.whatIHeard = 'whatever'
})
