import { expect, test } from 'vitest'

let attempts = 0

test('honors object-form retries before quarantining', { retry: { count: 1 } }, () => {
  attempts++
  expect(attempts).toBe(2)
})
