/* eslint-disable */
describe('flaky test retry', () => {
  let numAttempt = 0
  it('eventually passes', () => {
    cy.log('attempt', numAttempt)
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', numAttempt++ > 2 ? 'Hello World' : 'Hello Warld')
  })
})
