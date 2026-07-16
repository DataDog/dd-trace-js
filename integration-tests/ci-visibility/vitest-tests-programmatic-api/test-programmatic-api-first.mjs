import { describe, expect, test } from 'vitest'

describe('programmatic api first run', () => {
  test('can pass before a rerun', () => {
    expect(1 + 1).toBe(2)
  })
})
