import { afterAll, expect, vi } from 'vitest'

let calls = 0
vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(words => {
  calls++
  words.fill(1)
  return words
})

afterAll(() => {
  expect(calls).toBe(2)
  vi.restoreAllMocks()
})
