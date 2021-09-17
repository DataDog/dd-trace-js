/* eslint-disable */
context('can visit a page', () => {
  beforeEach(() => {
    cy.visit('/')
  })
  it('renders a hello world', () => {
    cy.get('.hello-world')
      .should('have.text', 'Hello World')
  })
  it('will fail', () => {
    cy.get('.hello-world')
      .should('have.text', 'Bye World')
  })
})
