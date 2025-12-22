'use strict'

const assert = require('assert')

const dependency = require('./dependency')

describe('subproject-test', () => {
  it('can run', () => {
    assert.strictEqual(dependency(1, 2), 3)
  })
})
