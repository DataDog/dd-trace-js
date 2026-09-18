/* eslint-disable */
const { getTestEnvironment } = require('../support/test-environment')

describe('flaky test retry', () => {
  let numAttempt = 0
  const passAttempt = Number(getTestEnvironment('FLAKY_PASS_ATTEMPT') || 2)

  it('eventually passes', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', numAttempt++ === passAttempt ? 'Hello World' : 'Hello Warld')
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
