/* eslint-disable */
describe('RUM correlation cookie rejection', () => {
  it('continues running the test', () => {
    expect(Cypress.env('DD_RUM_COOKIE_ATTEMPTED')).to.equal(true)
  })
})
