'use strict'

/* global cy, it */
it('observes completed before-run handlers', () => {
  cy.task('beforeRunOrder').should('deep.equal', ['first', 'second'])
})
