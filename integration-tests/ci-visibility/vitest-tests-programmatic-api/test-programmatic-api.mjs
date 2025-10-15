import { describe, test, expect } from 'vitest'

describe('programmatic api', () => {
  test('can report passed test', () => {
    expect(1 + 1).toBe(2)
  })

  test('can report failed test', () => {
    expect(1 + 1).toBe(3)
  })

  test.skip('can report skipped test', () => {
    expect(1 + 1).toBe(2)
  })
})
