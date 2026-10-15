'use strict'

const { test, expect } = require('@playwright/test')

for (const firstAttempt of [1, 2]) {
  test.describe(`starts on retry ${firstAttempt}`, () => {
    test.describe.configure({ mode: 'serial', retries: 2 })

    test('earlier sibling', () => {
      expect(test.info().retry).toBeGreaterThanOrEqual(firstAttempt)
    })

    test('later failure', () => {
      expect(true).toBe(false)
    })
  })
}
