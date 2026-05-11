/* eslint-disable */
describe('skipped', () => {
  it.skip('skipped', () => {
    cy.visitTestPage()
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})
