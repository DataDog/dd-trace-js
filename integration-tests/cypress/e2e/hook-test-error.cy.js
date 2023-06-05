/* eslint-disable */
let numTests = 0
describe('context', () => {
  afterEach(() => {
    if (numTests++ >= 1) {
      throw new Error('error in after each')
    }
  })
  it('passes', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
  it('passes too', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
  it('does not run because earlier afterEach fails', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})
