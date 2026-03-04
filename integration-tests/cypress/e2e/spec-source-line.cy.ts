/* eslint-disable @typescript-eslint/no-explicit-any */
declare const cy: any
declare const describe: any
declare const it: any

describe('typescript source line', () => {
  it('reports source line from ts', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})
