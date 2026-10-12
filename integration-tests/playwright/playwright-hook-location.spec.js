'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  createParallelIt,
} = require('../helpers')
const { NODE_MAJOR } = require('../../version')
const { TEST_STATUS } = require('../../packages/dd-trace/src/plugins/util/test')

// Playwright 1.64.0 builds hook step stacks from hook.location. An undefined location used to end up
// as [undefined] in the retained trace and crash the worker. The version is pinned so the scenario
// stays covered when "latest" moves on. Playwright 1.64 does not support Node.js 18.
const PLAYWRIGHT_VERSION_WITH_HOOK_STACK = '1.64.0'

const describeSupported = NODE_MAJOR >= 20 ? describe : describe.skip

describeSupported(`playwright@${PLAYWRIGHT_VERSION_WITH_HOOK_STACK} injected hook location`, function () {
  const it = createParallelIt(global.it, { withReceiver: true })

  let cwd

  this.timeout(80000)

  useSandbox([`@playwright/test@${PLAYWRIGHT_VERSION_WITH_HOOK_STACK}`], true)

  before(() => {
    cwd = sandboxCwd()
  })

  it('does not crash when the injected afterEach hook has a retained trace', async (receiver, run) => {
    const receiverPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)

        assert.equal(tests.length, 2)
        for (const test of tests) {
          assert.equal(test.meta[TEST_STATUS], 'pass')
        }
      })

    const proc = run(
      './node_modules/.bin/playwright test -c playwright.config.js injected-hook-location-test.js',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TEST_DIR: './ci-visibility/playwright-tests-hook-location',
        },
      }
    )

    const [[exitCode]] = await Promise.all([once(proc, 'exit'), receiverPromise])

    assert.equal(exitCode, 0)
  })
})
