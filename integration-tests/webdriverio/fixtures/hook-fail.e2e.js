'use strict'

describe('WebdriverIO hook failure', () => {
  before(() => {
    throw new Error('expected WebdriverIO hook failure')
  })

  it('does not run', () => {})
})
