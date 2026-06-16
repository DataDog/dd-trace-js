import { describe, expect, it } from 'vitest'

describe('vitest worker env', () => {
  it('sets DD_VITEST_WORKER', () => {
    expect(process.env.DD_VITEST_WORKER).toBe('1')
  })
})
