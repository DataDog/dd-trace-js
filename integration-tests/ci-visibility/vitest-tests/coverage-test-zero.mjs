import { describe, test, expect } from 'vitest'
import { sum } from './sum'

describe('code coverage', () => {
  test('passes', () => {
    expect(typeof sum === 'function').toBe(true)
  })
})
