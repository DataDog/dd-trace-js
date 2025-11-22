'use strict'

const assert = require('node:assert/strict')

const dependency = require('./dependency')



describe('subproject-test', () => {
  it('can run', () => {
    assert.strictEqual(dependency(1, 2), 3)
  })
})
