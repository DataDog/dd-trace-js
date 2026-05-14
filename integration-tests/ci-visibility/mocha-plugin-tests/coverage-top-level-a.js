'use strict'

const assert = require('node:assert/strict')

it('covers top-level dependency a', () => {
  assert.strictEqual(require('./coverage-top-level-dep-a')(), 'a')
})
