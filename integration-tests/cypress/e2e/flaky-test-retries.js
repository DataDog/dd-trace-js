/* eslint-disable */
describe('flaky test retry', () => {
  let numAttempt = 0
  it('eventually passes', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', numAttempt++ === 2 ? 'Hello World' : 'Hello Warld')
  })
  it('never passes', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello Warld')
  })
  it('always passes', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})
