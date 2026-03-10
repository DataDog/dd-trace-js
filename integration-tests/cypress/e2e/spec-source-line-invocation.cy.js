/* global describe, it, cy */
'use strict'

// Deliberate: keep this fixture as plain JS with no source map.
// We validate the fast path that trusts invocationDetails.line directly
// and skips source-map/declaration resolution.

describe('spec source line invocation details js', () => {
  it('uses invocation details line as source line', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})
