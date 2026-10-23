'use strict'

const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')

const { Before, Given } = require('@cucumber/cucumber')
const sinon = require('sinon')

// Advance only instrumentation's monotonic clock, so even five-minute scenarios
// exercise real Cucumber retry scheduling without waiting in real time.
let elapsed = 0
sinon.stub(performance, 'now').callsFake(() => elapsed)
const attempts = new Map()

Before(function ({ pickle }) {
  this.attempt = (attempts.get(pickle.id) ?? 0) + 1
  attempts.set(pickle.id, this.attempt)
})

Given('the first attempt takes {int} ms and fails {int} times', function (durationMs, failures) {
  if (this.attempt === 1) elapsed += durationMs
  assert.ok(this.attempt > failures, 'scenario failure')
})

Given('the scenario is skipped', function () {
  return 'skipped'
})
