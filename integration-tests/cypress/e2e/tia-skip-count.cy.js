/* eslint-disable */
describe('suite', () => {
  it('TIA skip one', () => { throw new Error('TIA should skip this test') })
  it('TIA skip two', () => { throw new Error('TIA should skip this test') })
  it.skip('framework skip', () => { throw new Error('Framework should skip this test') })
  it('passing', () => { expect(true).to.equal(true) })
})
