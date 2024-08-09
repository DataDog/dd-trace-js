import { describe, test, expect } from 'vitest'
import { sum } from './sum'

describe('code coverage', () => {
  test('passes', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
