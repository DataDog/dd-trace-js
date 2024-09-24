import { describe, test, expect } from 'vitest'
import { sum } from './sum'

let numAttempt = 0

describe('early flake detection', () => {
  test('can retry tests that eventually pass', () => {
    expect(sum(1, 2)).to.equal(numAttempt++ > 1 ? 3 : 4)
  })

  test('can retry tests that always pass', () => {
    if (process.env.ALWAYS_FAIL) {
      expect(sum(1, 2)).to.equal(4)
    } else {
      expect(sum(1, 2)).to.equal(3)
    }
  })

  test('does not retry if it is not new', () => {
    expect(sum(1, 2)).to.equal(3)
  })

  test.skip('does not retry if the test is skipped', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
