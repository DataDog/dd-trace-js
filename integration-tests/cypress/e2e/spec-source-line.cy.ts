/* eslint-disable */
// This file is used to reproduce the issue where testSourceLine is not correctly
// detected for test files compiled from TypeScript.
// The TypeScript-only declarations below are removed during compilation,
// which may cause the line numbers to shift in the compiled output.
interface TypeScriptOnlyInterface {
  field: string
}

describe('spec source line', () => {
  it('reports correct line number', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})
