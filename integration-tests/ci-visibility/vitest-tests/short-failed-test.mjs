import { expect, test } from 'vitest'

test('reports a non-negative duration for a short failed test', () => {
  expect(true).toBe(false)
})
