/* eslint-disable */
let attempt = 0

describe('efd with manual cypress retries', () => {
  it('fails first then passes', () => {
    cy.then(() => {
      expect(attempt++).to.equal(2)
    })
  })
})
