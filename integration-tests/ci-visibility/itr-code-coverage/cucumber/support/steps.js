'use strict'

const assert = require('node:assert/strict')

const { Given } = require('@cucumber/cucumber')

Given('the run dependency is covered', () => {
  const sum = require('../../src/run-dependency')
  assert.strictEqual(sum(1, 2), 3)
})

Given('the skipped dependency is covered', () => {
  const sum = require('../../src/skipped-dependency')
  assert.strictEqual(sum(1, 2), 3)
})
