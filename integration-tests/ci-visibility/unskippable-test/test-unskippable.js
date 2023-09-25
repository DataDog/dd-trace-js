/**
 * @jest-environment-options {"datadogUnskippable": true}
 */

const { expect } = require('chai')

describe('test-not-to-skip', () => {
  it('can report tests', () => {
    expect(1 + 2).to.equal(3)
  })
})
