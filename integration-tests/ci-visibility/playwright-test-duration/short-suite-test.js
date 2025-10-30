'use strict'

const { test, expect } = require('@playwright/test')

test.describe('short suite', () => {
  test('should be able to run', async () => {
    expect(true).toBe(true)
  })

  test.skip('should skip and not mess up the duration of the test suite', async () => {
    // TODO
  })
})
