/* global describe, it, cy, Cypress */
interface TypeOnly {
  field: string
}

const NO_MATCH_TITLE = ['no', 'match', 'title'].join(' ')

describe('spec source line no match', () => {
  it(NO_MATCH_TITLE, () => {
    Cypress.mocha.getRunner().currentRunnable.invocationDetails.line = 9999
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})
