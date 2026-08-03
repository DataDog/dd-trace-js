import { describe, expect, it } from 'vitest'

import { sum } from '../vitest-tests/bad-sum.mjs'

describe('TIA programmatic second run', () => {
  it('reports coverage after a skipped run', () => {
    expect(sum(1, 2)).toBe(3)
  })
})
