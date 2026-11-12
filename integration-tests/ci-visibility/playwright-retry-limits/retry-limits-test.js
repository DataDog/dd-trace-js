'use strict'

const { test, expect } = require('@playwright/test')

test('default retries @smoke', () => {
  expect(true).toBe(false)
})

for (const retries of [0, 1]) {
  test.describe(`suite retries ${retries}`, () => {
    test.describe.configure({ retries })

    test('always fails @smoke', () => {
      expect(true).toBe(false)
    })
  })
}
