import { describe, expect, test } from 'vitest'

import { sum } from './sum'

describe('TIA shared second suite', () => {
  test('uses a source file shared with another suite', () => {
    expect(sum(2, 3)).to.equal(5)
  })
})
