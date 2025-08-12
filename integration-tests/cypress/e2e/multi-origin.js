/* eslint-disable */

it('tests multiple origins', () => {
  // Visit first site
  cy.visit('/');
  cy.get('.hello-world')
    .should('have.text', 'Hello World')

  // Visit second site
  cy.origin(Cypress.env('BASE_URL_SECOND'), () => {
    cy.visit('/')
    cy.get('.hella-world').should('have.text', 'Hella World')
  });
});
