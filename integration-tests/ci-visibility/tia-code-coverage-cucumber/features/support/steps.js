'use strict'

const assert = require('node:assert/strict')
const { When, Then } = require('@cucumber/cucumber')

const runDependency = require('../../src/run-dependency')
const skippedDependency = require('../../src/skipped-dependency')

When('the run dependency is covered', function () {
  this.coverageResult = runDependency(1, 2)
})

When('the skipped dependency is covered', function () {
  this.coverageResult = skippedDependency(1, 2)
})

Then('the coverage result should be {int}', function (expected) {
  assert.strictEqual(this.coverageResult, expected)
})
