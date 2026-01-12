'use strict'

const assert = require('assert')

const { Given, When, Then } = require('@cucumber/cucumber')
// eslint-disable-next-line import/order
const tracer = require('dd-trace')
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
  assert.strictEqual(result, expected)
})
