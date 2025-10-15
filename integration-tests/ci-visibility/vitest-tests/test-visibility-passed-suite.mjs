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
  test.skip('can skip', () => {
    expect(sum(1, 2)).to.equal(3)
  })
  test.todo('can todo', () => {
    expect(sum(1, 2)).to.equal(3)
  })
  test('can programmatic skip', (context) => {
    context.skip()
    expect(sum(1, 2)).to.equal(3)
  })
})

test('no suite', () => {
  expect(sum(1, 2)).to.equal(3)
})

test.skip('skip no suite', () => {
  expect(sum(1, 2)).to.equal(3)
})

test('programmatic skip no suite', (context) => {
  context.skip()
  expect(sum(1, 2)).to.equal(3)
})
