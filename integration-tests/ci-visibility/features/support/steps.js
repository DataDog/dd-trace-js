'use strict'

const tracer = require('dd-trace')
const assert = require('assert')
const { When, Then, Before, After } = require('@cucumber/cucumber')

function getGreeter () {
  const Greeter = require('../../shared-greeter')
  return new Greeter()
}

Before('@skip', function () {
  return 'skipped'
})

After(function () {
  tracer.scope().active().addTags({
    'custom_tag.after': 'hello after',
  })
})

Before(function () {
  tracer.scope().active().addTags({
    'custom_tag.before': 'hello before',
  })
})

Then('I should have heard {string}', function (expectedResponse) {
  assert.equal(this.whatIHeard, expectedResponse)
})

When('the greeter says farewell', function () {
  this.whatIHeard = getGreeter().sayFarewell()
})

When('the greeter says yo', function () {
  this.whatIHeard = getGreeter().sayYo()
})

When('the greeter says yeah', function () {
  this.whatIHeard = getGreeter().sayYeah()
})

When('the greeter says greetings', function () {
  tracer.scope().active().addTags({
    'custom_tag.when': 'hello when',
  })
  this.whatIHeard = getGreeter().sayGreetings()
})

When('the greeter says whatever', function () {
  this.whatIHeard = 'whatever'
})
