/* eslint-disable */

describe('attempt to fix order', () => {
  it('first test', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })

  it('second test', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })

  it('third test', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})
