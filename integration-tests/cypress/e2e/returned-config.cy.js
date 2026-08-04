/* eslint-disable */
describe('returned config', () => {
  it('uses env from setupNodeEvents return value', () => {
    expect(Cypress.env('RETURNED_CONFIG_FLAG')).to.equal('true')
  })
})
