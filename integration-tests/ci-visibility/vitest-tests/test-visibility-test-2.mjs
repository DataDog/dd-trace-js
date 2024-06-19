import { describe, test, expect } from 'vitest'
import { sum } from './sum'

describe('test visibility 2', () => {
  test('can report tests 2', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
