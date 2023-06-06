/* eslint-disable */
describe('after', () => {
  after(() => {
    throw new Error('error in after hook')
  })
  it('passes', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
  it('will be marked as failed', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})

describe('before', () => {
  before(() => {
    throw new Error('error in before hook')
  })
  it('will be skipped', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})
