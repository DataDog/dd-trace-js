/* eslint-disable */
import { describe, it } from 'mocha';
import cy from 'cypress';

describe('context', () => {
  it('passes', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello World')
  })
})

describe('other context', () => {
  it('fails', () => {
    cy.visit('/')
      .get('.hello-world')
      .should('have.text', 'Hello Warld')
  })
})
