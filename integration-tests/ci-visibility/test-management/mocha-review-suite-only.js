'use strict'

const assert = require('node:assert/strict')
const forEach = require('mocha-each')

forEach([[1], [2]], undefined, global.suite).describe('row %s', value => {
  global.test('passes', () => { assert.ok(value === 1 || value === 2) })
})
