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
  // eslint-disable-next-line
  test('can programmatic skip', (context) => {
    // eslint-disable-next-line
    context.skip()
    expect(sum(1, 2)).to.equal(3)
  })
})
