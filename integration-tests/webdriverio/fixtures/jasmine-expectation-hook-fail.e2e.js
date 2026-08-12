'use strict'

describe('WebdriverIO Jasmine expectation hook failures', () => {
  describe('beforeEach', () => {
    beforeEach(() => {
      globalThis.expect(true).toBe(false)
    })

    it('does not retry with ATR', () => {})
  })

  describe('afterEach', () => {
    let attempts = 0

    afterEach(() => {
      if (attempts++ === 2) {
        globalThis.expect(true).toBe(false)
      }
    })

    it('keeps the final EFD failure', () => {})
  })
})
