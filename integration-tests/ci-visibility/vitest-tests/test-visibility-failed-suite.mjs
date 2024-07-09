import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { sum } from './sum'

let preparedValue = 1

describe('test-visibility-failed-suite-first-describe', () => {
  beforeEach(() => {
    preparedValue = 2
  })
  test('can report failed test', () => {
    expect(sum(1, 2)).to.equal(4)
  })
  test('can report more', () => {
    expect(sum(1, 2)).to.equal(3)
    expect(preparedValue).to.equal(2)
  })
})

describe('test-visibility-failed-suite-second-describe', () => {
  afterEach(() => {
    preparedValue = 1
  })
  test('can report passed test', () => {
    expect(sum(1, 2)).to.equal(3)
  })
  test('can report more', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
