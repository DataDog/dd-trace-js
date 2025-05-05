/* eslint-disable */
describe('impacted test', () => {
  it('is impacted test', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})
