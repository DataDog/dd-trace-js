import { describe, expect, it } from 'vitest'

describe('TIA ordinary skipped suite', () => {
  it('can be skipped', () => {
    expect(1 + 2).toBe(3)
  })
})
