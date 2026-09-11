/* eslint-disable */

describe('dynamic ATR retries', () => {
  it('uses the shortest retry budget', () => {
    throw new Error('short dynamic ATR test failure')
  })

  it('uses the next retry budget', () => {
    cy.wait(5_100).then(() => {
      throw new Error('long dynamic ATR test failure')
    })
  })
})
