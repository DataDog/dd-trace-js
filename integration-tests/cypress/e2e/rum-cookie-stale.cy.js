/* eslint-disable */
const rumCookieName = 'datadog-ci-visibility-test-execution-id'

describe('RUM correlation cookie lifecycle', () => {
  it('sets the initial cookie', () => {
    cy.getCookie(rumCookieName).then((cookie) => {
      expect(cookie && cookie.value).to.match(/^\d+$/)
      Cypress.env('RUM_COOKIE_FAILURE', 'reject')
    })
  })

  it('removes the previous cookie when replacement fails', () => {
    cy.getCookie(rumCookieName).should('be.null')
  })
})
