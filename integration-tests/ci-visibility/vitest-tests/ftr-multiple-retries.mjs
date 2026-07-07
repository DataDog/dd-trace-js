import { describe, test, expect } from 'vitest'
import { sum } from './bad-sum'

let count = 0

describe('dynamic instrumentation', () => {
  test('can sum across multiple failures', () => {
    if (count++ < 3) {
      expect(sum(11, 2)).to.equal(13)
    }
    expect(sum(1, 2)).to.equal(3)
  })
})
