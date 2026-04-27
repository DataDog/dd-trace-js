import { describe, test, expect } from 'vitest'
import { sharedSum } from '../vitest-shared/shared-sum.mjs'

describe('vitest repo root run suite', () => {
  test('uses shared code outside cwd', () => {
    expect(sharedSum(2, 3)).to.equal(5)
  })
})
