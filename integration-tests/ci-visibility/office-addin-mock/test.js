'use strict'

const assert = require('assert')

const sum = require('./dependency')
test('can sum', () => {
  assert.strictEqual(sum(1, 2), 3)
})
