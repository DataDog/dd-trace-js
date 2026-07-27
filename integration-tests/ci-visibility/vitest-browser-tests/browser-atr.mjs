import { expect, test } from 'vitest'

let attempts = 0

test('retries a failing browser test', () => {
  attempts++
  expect(attempts).toBe(2)
})
