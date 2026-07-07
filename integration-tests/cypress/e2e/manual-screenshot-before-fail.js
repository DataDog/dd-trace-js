/* eslint-disable */
describe('manual screenshot before fail suite', () => {
  beforeEach(() => {
    cy.visit('/')
  })

  it('takes a manual screenshot then fails', () => {
    // Manual capture (not a failure frame): must NOT be uploaded to the failure-screenshot endpoint.
    cy.screenshot('before-failure (failed)')
    cy.get('.hello-world')
      .should('have.text', 'Hello warld')
  })
})
