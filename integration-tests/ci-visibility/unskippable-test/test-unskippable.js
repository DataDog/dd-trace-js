/**
 * @datadog {"unskippable": true}
 */
'use strict'

const { expect } = require('chai')

describe('test-unskippable', () => {
  it('can report tests', () => {
    expect(1 + 2).to.equal(3)
  })
})
