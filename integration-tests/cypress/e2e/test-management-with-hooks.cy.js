/* eslint-disable */
describe('quarantined with hooks', () => {
  beforeEach(() => {
    cy.visitTestPage()
  })
  afterEach(() => {
    // cleanup
  })
  it('is quarantined', () => {
    cy.get('.hello-world').should('have.text', 'Hello Warld')
  })
  it('passes normally', () => {
    cy.get('.hello-world').should('have.text', 'Hello World')
  })
})

describe('quarantined with failing afterEach', () => {
  beforeEach(() => {
    cy.visitTestPage()
  })
  afterEach(() => {
    throw new Error('error in afterEach hook')
  })
  it('is quarantined', () => {
    cy.get('.hello-world').should('have.text', 'Hello World')
  })
})

describe('disabled with hooks', () => {
  beforeEach(() => {
    cy.visitTestPage()
  })
  afterEach(() => {
    // cleanup
  })
  it('is disabled', () => {
    cy.get('.hello-world').should('have.text', 'Hello Warld')
  })
})
