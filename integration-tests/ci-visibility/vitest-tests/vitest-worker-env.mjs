import { describe, expect, it } from 'vitest'

describe('vitest worker env', () => {
  it('sets DD_VITEST_WORKER', async () => {
    if (process.env.EXPECT_TEST_DURATION === '1') {
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    expect(process.env.DD_VITEST_WORKER).toBe('1')

    if (process.env.EXPECT_DD_NODE_OPTIONS_STRIPPED === '1') {
      const nodeOptions = process.env.NODE_OPTIONS || ''
      expect(nodeOptions.includes('dd-trace/register.js')).toBe(false)
      expect(nodeOptions.includes('dd-trace/ci/init')).toBe(false)
      expect(nodeOptions.includes('--no-warnings')).toBe(true)
      if (process.env.EXPECT_DD_NODE_OPTIONS_WINDOWS_PATH_PRESERVED === '1') {
        expect(/C:\\+tools\\+hook\.js/.test(nodeOptions)).toBe(true)
        expect(nodeOptions.includes('C:toolshook.js')).toBe(false)
      }
    }

    if (process.env.EXPECT_DD_NODE_OPTIONS_PRESENT === '1') {
      const nodeOptions = process.env.NODE_OPTIONS || ''
      expect(nodeOptions.includes('dd-trace/register.js')).toBe(true)
      expect(nodeOptions.includes('dd-trace/ci/init')).toBe(true)
      expect(nodeOptions.includes('--no-warnings')).toBe(true)
    }
  })
})
