'use strict'

describe('skipped suite', () => {
  // Deliberately skipped to exercise session status aggregation.
  xit('skipped test', () => { throw new Error('skipped test ran') })
})
