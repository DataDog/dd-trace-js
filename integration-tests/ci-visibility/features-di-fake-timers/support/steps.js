'use strict'

const assert = require('assert')
const { When, Then, BeforeAll, AfterAll } = require('@cucumber/cucumber')
const sinon = require('sinon')
const sum = require('../../features-di/support/sum')

let clock

BeforeAll(function () {
  clock = sinon.useFakeTimers()
})

AfterAll(function () {
  clock.restore()
})

When('the greeter says hello', function () {
  this.whatIHeard = 'hello'
})

Then('I should have heard {string}', function (expectedResponse) {
  sum(11, 3)
  assert.equal(this.whatIHeard, expectedResponse)
})
