'use strict'

const assert = require('assert')

require('./top-level-side-effect')

describe('top-level-side-effect-test', () => {
  it('can run', () => {
    assert.strictEqual(global.__ddMochaTopLevelSideEffect, true)
  })
})
