import { expect, test } from 'vitest'

let attempt = 0
const passAttempt = Number(process.env.EFD_PASS_ATTEMPT || 0)

test('EFD retries', () => {
  expect(++attempt).toBe(passAttempt)
})
