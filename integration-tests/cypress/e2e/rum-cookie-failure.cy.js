/* eslint-disable */
describe('RUM correlation cookie failure', () => {
  it('continues running the test', () => {
    if (Cypress.env('MISSING_CY_NOW')) {
      expect(Cypress.env('DD_RUM_COOKIE_NOW_MISSING')).to.equal(true)
    } else {
      expect(Cypress.env('DD_RUM_COOKIE_ATTEMPTED')).to.equal(true)
    }
  })
})
