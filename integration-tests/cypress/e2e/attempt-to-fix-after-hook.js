/* eslint-disable */

describe('attempt to fix after hook', () => {
  after(() => {
    throw new Error('error in after hook')
  })

  it('passes before after hook fails', () => {
    cy.visitTestPage()
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})
