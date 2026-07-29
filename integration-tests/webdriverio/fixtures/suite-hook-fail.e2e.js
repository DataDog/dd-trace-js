'use strict'

const hookType = process.env.WEBDRIVERIO_SUITE_HOOK

describe('WebdriverIO suite hook failure', () => {
  if (hookType === 'beforeAll') {
    before(() => {
      throw new Error('beforeAll failure')
    })
  } else {
    after(() => {
      throw new Error('afterAll failure')
    })
  }

  it('is quarantined', () => {})
})
