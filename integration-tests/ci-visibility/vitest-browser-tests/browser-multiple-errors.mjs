import { afterEach, expect, test } from 'vitest'

afterEach(() => {
  throw new Error('cleanup failed')
})

test('reports one attempt when the test and its cleanup fail', () => {
  expect(1).toBe(2)
})
