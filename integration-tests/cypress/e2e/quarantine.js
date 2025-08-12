/* eslint-disable */
describe('quarantine', () => {
  it('is quarantined', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello Warld')
  })
})
