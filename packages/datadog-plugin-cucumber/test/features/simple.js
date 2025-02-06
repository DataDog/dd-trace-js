'use strict'

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

Before('@hooks-fail', function () {
  const unsafe = {}
  unsafe.yeah.boom = 'crash'
})

When('run', () => {})

When('integration', function () {
  const http = require('http')
  return new Promise(resolve => {
    http.request('http://test:123', () => {
      resolve()
    }).end()
  })
})

Then('pass', function () {
  expect(this.datadog).to.eql('datadog')
})

Then('fail', function () {
  expect(this.datadog).to.eql('godatad')
})

Then('skip', function () {
  return 'skipped'
})
