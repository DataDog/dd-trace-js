/* eslint-disable */

it('constructor', () => {
  throw new Error('constructor dynamic ATR test failure')
})

it('uses the next retry budget', () => {
  cy.wait(5_100).then(() => {
    throw new Error('long dynamic ATR test failure')
  })
})
