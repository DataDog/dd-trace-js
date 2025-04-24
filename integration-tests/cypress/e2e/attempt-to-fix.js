/* eslint-disable */

let numAttempt = 0

function getTextToAssert () {
  if (Cypress.env('SHOULD_ALWAYS_PASS')) {
    return 'Hello World'
  } else if (Cypress.env('SHOULD_FAIL_SOMETIMES')) {
    return numAttempt++ % 2 === 0 ? 'Hello World' : 'Hello Warld'
  }
  return 'Hello Warld'
}

describe('attempt to fix', () => {
  it('is attempt to fix', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', getTextToAssert())
  })
})
