'use strict'

const assert = require('assert')

const dependency = require('../shared-dependency')

describe('external-dependency-test', () => {
  it('can run', () => {
    assert.strictEqual(dependency(1, 2), 3)
  })
})
