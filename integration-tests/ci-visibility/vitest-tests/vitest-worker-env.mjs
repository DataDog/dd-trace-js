import { describe, expect, it } from 'vitest'

describe('vitest worker env', () => {
  it('sets DD_VITEST_WORKER', () => {
    expect(process.env.DD_VITEST_WORKER).toBe('1')

    if (process.env.EXPECT_DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE) {
      expect(process.env.DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE).toBe('1')
    }

    if (process.env.EXPECT_NO_DD_TRACE_INIT) {
      expect(globalThis._ddtrace).toBeUndefined()
    }
  })
})
