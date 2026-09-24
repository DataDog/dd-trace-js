/* eslint-disable */

const { getTestEnvironment } = require('../support/test-environment')

let numAttempt = 0

function getTextToAssert () {
  if (getTestEnvironment('SHOULD_ALWAYS_PASS')) {
    return 'Hello World'
  } else if (getTestEnvironment('SHOULD_FAIL_SOMETIMES')) {
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
