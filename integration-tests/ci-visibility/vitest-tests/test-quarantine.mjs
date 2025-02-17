import { describe, test, expect } from 'vitest'

describe('quarantine tests', () => {
  test('can quarantine a test', () => {
    expect(1 + 2).to.equal(4)
  })

  test('can pass normally', () => {
    expect(1 + 2).to.equal(3)
  })
})
