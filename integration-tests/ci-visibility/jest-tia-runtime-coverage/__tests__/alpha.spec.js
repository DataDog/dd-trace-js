'use strict'

const assert = require('node:assert/strict')

require('../src/side-effect')

const { chooseBranch } = require('../src/branch')
const { sharedLabel } = require('../src/shared')
require('../src/passive')

describe('alpha suite', () => {
  it('touches direct, side-effect, lazy, passive, and throwing modules', () => {
    const lazyMessage = require('../src/lazy')

    assert.strictEqual(sharedLabel('alpha'), 'alpha:3')
    assert.strictEqual(chooseBranch('alpha'), 'first')
    assert.strictEqual(lazyMessage('alpha'), 'lazy:alpha')
    assert.strictEqual(global.__ddTiaRuntimeCoverageSideEffect, 1)
    assert.throws(() => require('../src/throws-on-import'), /expected import failure/)
  })
})
