'use strict'

describe('WebdriverIO console log submission', () => {
  it('submits a global console warning', () => {
    // eslint-disable-next-line no-console
    console.warn('WebdriverIO console warning: %s', 'details')
  })
})
