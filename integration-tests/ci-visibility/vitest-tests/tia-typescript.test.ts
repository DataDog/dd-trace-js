import { describe, expect, it } from 'vitest'

import { multiply } from './tia-typescript-source'

describe('TIA TypeScript suite', () => {
  it('reports transformed TypeScript sources', () => {
    expect(multiply(3, 4)).toBe(12)
  })
})
