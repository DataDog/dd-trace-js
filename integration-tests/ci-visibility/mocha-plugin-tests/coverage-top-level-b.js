'use strict'

const assert = require('node:assert/strict')

it('covers top-level dependency b', () => {
  assert.strictEqual(require('./coverage-top-level-dep-b')(), 'b')
})
