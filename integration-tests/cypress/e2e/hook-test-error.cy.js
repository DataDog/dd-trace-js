/* eslint-disable */
let numTests = 0
describe('hook-test-error tests', () => {
  afterEach(() => {
    if (numTests++ >= 1) {
      throw new Error('error in after each hook')
    }
  })
  it('passes', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
  it('will fail because afterEach fails', () => {
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
