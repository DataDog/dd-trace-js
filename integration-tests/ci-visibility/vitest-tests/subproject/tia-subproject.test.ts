import { describe, expect, it } from 'vitest'

import { subtract } from './tia-subproject-source'

describe('TIA subproject suite', () => {
  it('reports paths relative to the repository root', () => {
    expect(subtract(5, 3)).toBe(2)
  })
})
