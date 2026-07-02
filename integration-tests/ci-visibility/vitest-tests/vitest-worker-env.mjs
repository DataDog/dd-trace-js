import { describe, expect, it } from 'vitest'

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('vitest worker env', () => {
  it('sets DD_VITEST_WORKER', async () => {
    if (process.env.WAIT_BEFORE_EXPECTATION_MS) {
      await wait(Number(process.env.WAIT_BEFORE_EXPECTATION_MS))
    }

    expect(process.env.DD_VITEST_WORKER).toBe('1')

    if (process.env.EXPECT_DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE) {
      expect(process.env.DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE).toBe('1')
    }

    if (process.env.EXPECT_DD_TEST_OPT_VITEST_NO_WORKER_INIT_INACTIVE) {
      expect(process.env.DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE).toBeUndefined()
    }

    if (process.env.EXPECT_NO_DD_TRACE_INIT) {
      expect(globalThis._ddtrace).toBeUndefined()
    }

    if (process.env.EXPECT_DD_NODE_OPTIONS_STRIPPED) {
      expect(process.env.NODE_OPTIONS || '').not.toMatch(/dd-trace\/(?:register\.js|ci\/init(?:\.js)?)/)
    }

    if (process.env.EXPECT_DD_NODE_OPTIONS_PRESERVED) {
      expect(process.env.NODE_OPTIONS || '').toContain(process.env.EXPECT_DD_NODE_OPTIONS_PRESERVED)
    }
  })
})
