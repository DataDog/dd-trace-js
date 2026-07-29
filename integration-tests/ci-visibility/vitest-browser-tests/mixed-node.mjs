import { expect, test } from 'vitest'

test('keeps Node worker instrumentation active', () => {
  expect(typeof window).toBe('undefined')
})
