'use strict'

/**
 * @datadog {"unskippable": true}
 */

const { expect } = require('chai')

describe('test-unskippable', () => {
  it('can report tests', () => {
    expect(1 + 2).to.equal(3)
  })
})
