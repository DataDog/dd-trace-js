import { afterAll, expect, vi } from 'vitest'

let calls = 0
vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(words => {
  calls++
  if (calls !== 2) {
    throw new Error('mock getRandomValues failure')
  }
  words.fill(0)
  return words
})

afterAll(() => {
  expect(calls).toBe(2)
  vi.restoreAllMocks()
})
