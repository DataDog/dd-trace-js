import { describe, test, expect } from 'vitest'
import { sum } from './bad-sum'

describe('dynamic instrumentation', () => {
  test('can sum', () => {
    expect(sum(11, 2)).to.equal(13)
  })
  test('is not retried', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
