import { beforeAll, describe, expect, test } from 'vitest'

describe('failed suite hook', () => {
  beforeAll(() => {
    throw new Error('failed before all')
  })

  test('does not run the test body', () => {
    expect(1 + 2).toBe(3)
  })
})
