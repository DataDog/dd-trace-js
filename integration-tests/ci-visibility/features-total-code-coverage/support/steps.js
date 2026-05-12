'use strict'

const assert = require('node:assert/strict')

const { Given } = require('@cucumber/cucumber')

Given('the used dependency is covered', function () {
  const sum = require('../used-dependency')
  assert.strictEqual(sum(1, 2), 3)
})

Given('the unused dependency is covered', function () {
  const sum = require('../unused-dependency')
  assert.strictEqual(sum(1, 2), 3)
})
