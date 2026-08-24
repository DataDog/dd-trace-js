/* eslint-disable */
let attempt = 0

describe('numeric Cypress retries', () => {
  it('eventually passes', () => {
    cy.then(() => {
      expect(attempt++).to.equal(2)
    })
  })
})
