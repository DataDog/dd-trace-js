'use strict'

describe('skipped attempt to fix tests', () => {
  // This skip verifies that attempt-to-fix does not retry skipped tests.
  it.skip('can skip', () => {})
  it.todo('can be todo')
})
