'use strict'

const tracer = require('dd-trace')
const { Given, When, Then } = require('@cucumber/cucumber')
const { expect } = require('chai')

let num1, num2, result

Given('I have two numbers {int} and {int}', function (first, second) {
  tracer.startSpan('custom').finish()
  num1 = first
  num2 = second
})

When('I add them together', function () {
  result = num1 + num2
})

Then('the result should be {int}', function (expected) {
  expect(result).to.equal(expected)
})
