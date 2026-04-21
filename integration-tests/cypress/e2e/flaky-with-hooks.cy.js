/* eslint-disable */
let numAttempt = 0
describe('flaky with hooks', () => {
  beforeEach(() => {
    cy.visit('/')
  })
  afterEach(() => {
    // cleanup
  })
  it('eventually passes', () => {
    cy.get('.hello-world').should('have.text', numAttempt++ === 2 ? 'Hello World' : 'Hello Warld')
  })
  it('never passes', () => {
    cy.get('.hello-world').should('have.text', 'Hello Warld')
  })
  it('always passes', () => {
    cy.get('.hello-world').should('have.text', 'Hello World')
  })
})
