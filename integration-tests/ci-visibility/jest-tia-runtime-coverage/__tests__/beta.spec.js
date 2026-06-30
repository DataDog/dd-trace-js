'use strict'

const assert = require('node:assert/strict')

jest.mock('../src/manual-target.js', () => {
  return function manualTarget () {
    return 'mocked manual target'
  }
})

const { chooseBranch } = require('../src/branch')
const manualTarget = require('../src/manual-target.js')

describe('beta suite', () => {
  it('touches a mocked dependency without executing the real module', () => {
    assert.strictEqual(chooseBranch('beta'), 'fallback')
    assert.strictEqual(manualTarget(), 'mocked manual target')
  })
})
