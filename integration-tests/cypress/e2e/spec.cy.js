/* eslint-disable */
/**
 * @datadog {"unskippable": true}
 */
describe('context', () => {
  it('passes', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})

describe('other context', () => {
  it('fails', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello Warld')
  })
})
