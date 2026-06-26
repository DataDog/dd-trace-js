import { beforeAll, describe, expect, test } from 'vitest'
import { sum } from './sum'

describe('suite hook failure', () => {
  beforeAll(() => {
    throw new Error('failed before all')
  })

  test('can report passed test', () => {
    expect(sum(1, 2)).to.equal(3)
  })
})
