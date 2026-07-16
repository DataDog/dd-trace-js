'use strict'

const assert = require('assert')

const dependency = require('./dependency')

describe('subproject-test-2', () => {
  it('can run', () => {
    assert.strictEqual(dependency(2, 3), 5)
  })
})
