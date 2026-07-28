import { afterAll, vi } from 'vitest'

vi.useFakeTimers()

afterAll(() => {
  vi.useRealTimers()
})
