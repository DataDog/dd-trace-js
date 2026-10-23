/* eslint-disable */

afterEach(function () {
  if (this.currentTest.currentRetry() === 1) {
    Cypress.stop()
  }
})

it('stops before exhausting the retry budget', () => {
  throw new Error('failure before Cypress stops')
})
