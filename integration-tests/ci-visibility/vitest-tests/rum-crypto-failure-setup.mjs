import { afterEach, beforeEach, vi } from 'vitest'

beforeEach(({ task }) => {
  let calls = 0
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(words => {
    calls++
    if (task.name.includes('throws') || calls > 1) {
      throw new Error('mock getRandomValues failure')
    }
    words.fill(task.name.includes('fixed') ? 1 : 0)
    return words
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
