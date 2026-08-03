import { describe, expect, test } from 'vitest'

import { sum } from './bad-sum'

describe('TIA second suite', () => {
  test('uses the second source file', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
