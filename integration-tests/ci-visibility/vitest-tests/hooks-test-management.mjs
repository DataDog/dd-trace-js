import { describe, test, expect, beforeEach, afterEach } from 'vitest'

describe('test management with hooks', () => {
  beforeEach(() => {
    // setup
  })

  afterEach(() => {
    // teardown
  })

  test('can apply management to a failing test with hooks', () => {
    expect(1 + 2).to.equal(4) // intentionally fails
  })

  test('can pass normally with hooks', () => {
    expect(1 + 2).to.equal(3)
  })
})
