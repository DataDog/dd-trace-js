/* eslint-disable */
const { getTestEnvironment } = require('../support/test-environment')

let attempt = 0

describe('efd with manual cypress retries', () => {
  it('fails first then passes', () => {
    cy.then(() => {
      expect(attempt++).to.equal(Number(getTestEnvironment('EXPECTED_ATTEMPT') || 2))
    })
  })
})
