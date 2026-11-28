'use strict'

const assert = require('node:assert')

const sum = require('../test/sum')

module.exports = function sharedBody () {
  assert.strictEqual(sum(1, 2), 3)
}
