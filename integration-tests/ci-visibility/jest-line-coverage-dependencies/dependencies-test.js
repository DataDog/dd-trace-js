'use strict'

const assert = require('node:assert')

const { answer } = require('./mocked')
const sharedBody = require('./shared-body')

jest.mock('./mocked', () => ({ answer: () => 'from the factory' }))

describe('dependencies', () => {
  it('runs a body defined in another file', sharedBody)

  it('runs a line of its own file', () => {
    assert.strictEqual(answer(), 'from the factory')
  })
})
