import { describe, test, expect } from 'vitest'
import { sum } from './sum'

describe('itr suite one', () => {
  test('adds one and two', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
