import { describe, test, expect } from 'vitest'
import { sum } from './sum'

describe('test visibility', () => {
  test('can report tests', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
