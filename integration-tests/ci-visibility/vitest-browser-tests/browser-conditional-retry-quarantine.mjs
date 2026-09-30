import { afterAll, expect, test } from 'vitest'

let attempts = 0
let conditionCalls = 0

test('stops conditional retries before quarantining', {
  repeats: 1,
  retry: {
    count: 2,
    condition: () => {
      conditionCalls++
      return false
    },
  },
}, () => {
  attempts++
  throw new Error(`conditional retry attempt ${attempts}`)
})

afterAll(() => {
  expect(attempts).toBe(2)
  expect(conditionCalls).toBe(2)
})
