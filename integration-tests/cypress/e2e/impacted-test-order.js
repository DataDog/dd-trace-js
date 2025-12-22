/* eslint-disable */

describe('impacted test order', () => {
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
})
