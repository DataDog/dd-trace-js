import { describe, test, expect } from 'vitest'
import { sum } from './bad-sum'

let numAttempt = 0

describe('dynamic instrumentation', () => {
  test('can sum', () => {
    const shouldFail = numAttempt++ === 0
    if (shouldFail) {
      expect(sum(11, 2)).to.equal(13)
    } else {
      expect(sum(1, 2)).to.equal(3)
    }
  })
  test('is not retried', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
