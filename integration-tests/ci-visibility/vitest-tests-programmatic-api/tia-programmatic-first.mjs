import { describe, expect, it } from 'vitest'

import { sum } from '../vitest-tests/sum.mjs'

describe('TIA programmatic first run', () => {
  it('can be skipped', () => {
    expect(sum(1, 2)).toBe(3)
  })
})
