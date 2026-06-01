/* global describe, it, cy, Cypress */
interface TypeOnly {
  field: string
}

describe('spec source line fallback branch', () => {
  it('fallback branch literal title', () => {
    Cypress.mocha.getRunner().currentRunnable.invocationDetails.line = 9999
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})
