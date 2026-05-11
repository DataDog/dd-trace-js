/* eslint-disable */
describe('disable', () => {
  it('is disabled', () => {
    cy.visitTestPage()
      .get('.hello-world')
      .should('have.text', 'Hello Warld')
  })
})
