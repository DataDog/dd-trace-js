import { describe, expect, it } from 'vitest'

import { sum } from './sum.mjs'

describe('TIA failing suite', () => {
  it('reports coverage before failing', () => {
    expect(sum(1, 2)).toBe(4)
  })
})
