import { describe, test, expect } from 'vitest'
import { sum } from './sum'

let numAttempt = 0
let numOtherAttempt = 0

describe('early flake detection', () => {
  test('can retry tests that eventually pass', { repeats: process.env.SHOULD_REPEAT && 2 }, () => {
    expect(sum(1, 2)).to.equal(numAttempt++ > 1 ? 3 : 4)
  })

  test('can retry tests that always pass', { repeats: process.env.SHOULD_REPEAT && 2 }, () => {
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

  if (process.env.SHOULD_ADD_EVENTUALLY_FAIL) {
    test('can retry tests that eventually fail', () => {
      expect(sum(1, 2)).to.equal(numOtherAttempt++ < 3 ? 3 : 4)
    })
  }
})
