import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest'
import { sum } from './bad-sum'

describe('dynamic instrumentation fake timers', () => {
  // Install fake timers in beforeAll — they persist through test finish hooks,
  // which is the pattern that triggers the deadlock with DI's setTimeout.
  beforeAll(() => {
    vi.useFakeTimers()
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  test('can sum with fake timers', () => {
    expect(sum(11, 2)).to.equal(13)
  })
})
