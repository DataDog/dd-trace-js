/* eslint-disable */
describe('context', () => {
  it('passes', () => {
    cy.visitTestPage()
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})
