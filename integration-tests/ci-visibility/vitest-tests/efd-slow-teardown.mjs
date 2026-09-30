import { describe, expect, test } from 'vitest'

for (const outcome of ['fails', 'passes on retry', 'quarantined']) {
  describe(outcome, () => {
    let attempts = 0
    const fixtureTest = test.extend({
      // eslint-disable-next-line no-empty-pattern
      attempt: async ({}, use) => {
        await use(++attempts)
        if (attempts === 1) {
          await new Promise(resolve => setTimeout(resolve, 6000))
        }
      },
    })

    fixtureTest.aroundEach(async (runTest, { attempt }) => {
      expect(attempt).toBeGreaterThan(0)
      await runTest()
    })

    fixtureTest('after slow teardown', ({ attempt }) => {
      expect(attempt).toBe(outcome === 'passes on retry' ? 2 : 0)
    })
  })
}
