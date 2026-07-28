import { expect, test } from 'vitest'

let attempts = 0

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('retries a failing browser test', async () => {
  await wait(50)
  attempts++
  expect(attempts).toBe(2)
})
