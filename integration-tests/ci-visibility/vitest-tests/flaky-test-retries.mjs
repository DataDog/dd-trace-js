import { describe, test, expect } from 'vitest'
import { sum } from './sum'

let numAttempt = 0

describe('flaky test retries', () => {
  test('can retry tests that eventually pass', () => {
    expect(sum(1, 2)).to.equal(numAttempt++)
  })

  test('can retry tests that never pass', () => {
    expect(sum(1, 2)).to.equal(0)
  })

  test('does not retry if unnecessary', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
