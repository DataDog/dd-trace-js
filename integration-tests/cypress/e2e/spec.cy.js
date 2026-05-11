/* eslint-disable */
/**
 * @datadog {"unskippable": true}
 */
describe('context', () => {
  it('passes', () => {
    cy.visitTestPage()
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})

describe('other context', () => {
  it('fails', () => {
    cy.visitTestPage()
      .get('.hello-world')
      .should('have.text', 'Hello Warld')
  })
})
