import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { sum } from './sum'

describe('context', () => {
  beforeEach(() => {
    throw new Error('failed before each')
  })
  test('can report failed test', () => {
    expect(sum(1, 2)).to.equal(4)
  })
  test('can report more', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})

describe('other context', () => {
  afterEach(() => {
    throw new Error('failed after each')
  })
  test('can report passed test', () => {
    expect(sum(1, 2)).to.equal(3)
  })
  test('can report more', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
