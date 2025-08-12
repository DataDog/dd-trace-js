/* eslint-disable */
describe('disable', () => {
  it('is disabled', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello Warld')
  })
})
