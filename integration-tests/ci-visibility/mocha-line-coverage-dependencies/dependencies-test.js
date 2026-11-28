'use strict'

const assert = require('node:assert')

const sum = require('../test/sum')
const sharedBody = require('./shared-body')

describe('dependencies', () => {
  it('runs a body defined in another file', sharedBody)

  it('runs a line of its own file', () => {
    assert.strictEqual(sum(2, 2), 4)
  })
})
