import { describe, test, expect } from 'vitest'

describe('vitest repo root skipped suite', () => {
  test('would run if it were not skipped by ITR', () => {
    expect(1 + 1).to.equal(2)
  })
})
