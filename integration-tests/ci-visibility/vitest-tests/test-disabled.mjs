import { describe, test, expect } from 'vitest'

describe('disable tests', () => {
  test('can disable a test', () => {
    expect(1 + 2).to.equal(3)
  })
})
