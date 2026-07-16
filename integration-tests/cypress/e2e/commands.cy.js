/* eslint-disable */
describe('commands suite', () => {
  it('runs well-known commands', () => {
    cy.visit('/')
    cy.get('.hello-world')
      .should('exist')
      .and('have.text', 'Hello World')
      .and('be.visible')
    cy.url().should('include', '/')
    cy.contains('Hello World').should('be.visible')
    cy.title().should('be.a', 'string')
    cy.document().should('have.property', 'charset')
    cy.window().should('have.property', 'document')
  })

  it('fails on a step', () => {
    cy.visit('/')
    cy.get('.nonexistent-element').should('exist')
  })
})
