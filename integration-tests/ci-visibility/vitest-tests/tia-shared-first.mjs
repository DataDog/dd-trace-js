import { describe, expect, test } from 'vitest'

import { sum } from './sum'

describe('TIA shared first suite', () => {
  test('uses a source file shared with another suite', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
