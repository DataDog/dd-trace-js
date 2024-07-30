/* eslint-disable */
describe('context', () => {
  it('passes', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})
