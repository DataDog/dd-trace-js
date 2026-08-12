'use strict'

const assert = require('node:assert/strict')

const { Then } = require('@cucumber/cucumber')

Then('the scenario passes', function () {
  assert.ok(true)
})
