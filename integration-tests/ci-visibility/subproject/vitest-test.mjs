import { describe, test, expect } from 'vitest'

describe('context', () => {
  test('can report passed test', () => {
    expect(1 + 2).to.equal(3)
  })
})
