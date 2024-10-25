/* eslint-disable */
describe('skipped', () => {
  it.skip('skipped', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})
