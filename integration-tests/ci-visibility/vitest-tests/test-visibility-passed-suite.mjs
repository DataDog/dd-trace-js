import { describe, test, expect } from 'vitest'
import { sum } from './sum'

describe('context', () => {
  test('can report passed test', () => {
    expect(sum(1, 2)).to.equal(3)
  })
  test('can report more', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})

describe('other context', () => {
  test('can report passed test', () => {
    expect(sum(1, 2)).to.equal(3)
  })
  test('can report more', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
