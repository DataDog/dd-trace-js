import { expect, test, vi } from 'vitest'

test('uses real time for browser early flake detection with fake timers', () => {
  vi.advanceTimersByTime(6000)
  expect(true).toBe(true)
})
