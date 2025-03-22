/* eslint-disable */
describe('attempt to fix', () => {
  it('is attempt to fix', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello Warld')
  })
})
