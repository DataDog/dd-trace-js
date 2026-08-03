import { describe, expect, test } from 'vitest'

import { sum } from './sum'

describe('TIA first suite', () => {
  test('uses the first source file', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
