import { describe, expect, it } from 'vitest'

describe('vitest worker env', () => {
  it('sets DD_VITEST_WORKER', () => {
    expect(process.env.DD_VITEST_WORKER).toBe('1')

    if (process.env.EXPECT_DD_NODE_OPTIONS_STRIPPED === '1') {
      const nodeOptions = process.env.NODE_OPTIONS || ''
      expect(nodeOptions.includes('dd-trace/register.js')).toBe(false)
      expect(nodeOptions.includes('dd-trace/ci/init')).toBe(false)
      expect(nodeOptions.includes('--no-warnings')).toBe(true)
    }

    if (process.env.EXPECT_DD_NODE_OPTIONS_PRESENT === '1') {
      const nodeOptions = process.env.NODE_OPTIONS || ''
      expect(nodeOptions.includes('dd-trace/register.js')).toBe(true)
      expect(nodeOptions.includes('dd-trace/ci/init')).toBe(true)
      expect(nodeOptions.includes('--no-warnings')).toBe(true)
    }
  })
})
