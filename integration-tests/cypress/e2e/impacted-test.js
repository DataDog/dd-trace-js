/* eslint-disable */
describe('impacted test', () => {
  it('is impacted test', () => {
    cy.visitTestPage()
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})
