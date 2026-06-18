'use strict'

const assert = require('node:assert/strict')

const {
  mergeNodeOptions,
} = require('../../../../ci/test-optimization-validation/command-runner')

describe('test optimization validation command runner', () => {
  it('keeps project and validator NODE_OPTIONS together', () => {
    assert.strictEqual(
      mergeNodeOptions('--import ./src/dev-loader.js', '--import dd-trace/register.js -r dd-trace/ci/init'),
      '--import ./src/dev-loader.js --import dd-trace/register.js -r dd-trace/ci/init'
    )
  })
})
