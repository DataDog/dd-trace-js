'use strict'

const { Before, Given, When, Then, setWorldConstructor } = require('@cucumber/cucumber')
const assert = require('assert')

const ENDPOINT_URL = process.env.DD_CIVISIBILITY_AGENTLESS_URL ||
  `http://127.0.0.1:${process.env.DD_TRACE_AGENT_PORT}`

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
    http.request(`${ENDPOINT_URL}/info`, { agent: false }, () => {
      resolve()
    }).end()
  })
})

Then('pass', function () {
  assert.equal(this.datadog, 'datadog')
})

Then('fail', function () {
  assert.equal(this.datadog, 'godatad')
})

Then('skip', function () {
  return 'skipped'
})
