/* eslint-disable */
describe('quarantine', () => {
  it('is quarantined', () => {
    cy.visitTestPage()
      .get('.hello-world')
      .should('have.text', 'Hello Warld')
  })
})
