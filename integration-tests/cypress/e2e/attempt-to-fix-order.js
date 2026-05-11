/* eslint-disable */

describe('attempt to fix order', () => {
  it('first test', () => {
    cy.visitTestPage()
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })

  it('second test', () => {
    cy.visitTestPage()
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })

  it('third test', () => {
    cy.visitTestPage()
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})
