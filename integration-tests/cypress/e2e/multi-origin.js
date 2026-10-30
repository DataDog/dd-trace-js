/* eslint-disable */
const { getTestEnvironment } = require('../support/test-environment')

it('tests multiple origins', () => {
  // Visit first site
  cy.visit('/');
  cy.get('.hello-world')
    .should('have.text', 'Hello World')

  // Visit second site
  cy.origin(getTestEnvironment('BASE_URL_SECOND'), () => {
    cy.visit('/')
    cy.get('.hella-world').should('have.text', 'Hella World')
  });
});
