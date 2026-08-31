'use strict'

// eslint-disable-next-line no-undef -- Jasmine exposes afterAll through WebdriverIO.
afterAll(() => {
  throw new Error('expected WebdriverIO Jasmine global afterAll failure')
})

describe('Jasmine global afterAll failure', () => {
  it('passes before the global hook fails', () => {})
})
