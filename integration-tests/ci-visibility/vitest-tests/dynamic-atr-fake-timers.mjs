import { test, vi } from 'vitest'

test('fake timers do not extend the retry budget', () => {
  vi.advanceTimersByTime(6000)
  throw new Error('fast failure with fake timers')
})
