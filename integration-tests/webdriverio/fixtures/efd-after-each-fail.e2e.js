'use strict'

describe('WebdriverIO EFD afterEach failure', () => {
  afterEach(() => {
    throw new Error('EFD afterEach failure')
  })

  it('fails every EFD hook attempt', () => {})
})
