import { describe, test, expect } from 'vitest'
import { sum } from './sum'

describe('itr suite two', () => {
  test('adds two and three', () => {
    expect(sum(2, 3)).to.equal(5)
  })
})
