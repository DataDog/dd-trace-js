const { Before, Given, When, Then, setWorldConstructor } = require('@cucumber/cucumber')
const { expect } = require('chai')

const CustomWorld = function () {
  this.datadog = 0
}

CustomWorld.prototype.setTo = function (value) {
  this.datadog = value
}

setWorldConstructor(CustomWorld)

Before('@skip', function () {
  return 'skipped'
})

Given('datadog', function () {
  this.setTo('datadog')
})

When('run', () => {})

Then('pass', function () {
  expect(this.datadog).to.eql('datadog')
})

Then('fail', function () {
  expect(this.datadog).to.eql('godatad')
})

Then('skip', function () {
  return 'skipped'
})
