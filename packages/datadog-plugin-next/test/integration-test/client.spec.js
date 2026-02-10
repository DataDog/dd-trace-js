'use strict'

const assert = require('node:assert/strict')

const { execSync } = require('child_process')
const {
  FakeAgent,
  curlAndAssertMessage,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
  sandboxCwd,
  useSandbox,
  varySandbox,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../../integration-tests/helpers')
const { NODE_MAJOR } = require('../../../../version')

const hookFile = 'dd-trace/loader-hook.mjs'
const min = NODE_MAJOR >= 25 ? '>=13' : '>=11.1'

describe('esm', () => {
  let agent
  let proc
  let variants

  // These next versions have a dependency which uses a deprecated node buffer and match versions tested with unit tests
  withVersions('next', 'next', `${min} <17`, version => {
    useSandbox([`'next@${version}'`, 'react@^18.2.0', 'react-dom@^18.2.0'],
      false, ['./packages/datadog-plugin-next/test/integration-test/*'])

    before(async function () {
      // next builds slower in the CI, match timeout with unit tests
      this.timeout(300 * 1000)
      execSync('yarn exec next build', {
        cwd: sandboxCwd(),
        env: {
          ...process.env,
          NODE_OPTIONS: '--openssl-legacy-provider',
        },
      })
      variants = varySandbox('server.mjs', 'next')
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    for (const variant of varySandbox.VARIANTS) {
      it(`is instrumented loaded with ${variant}`, async () => {
        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port, {
          NODE_OPTIONS: `--loader=${hookFile} --require dd-trace/init --openssl-legacy-provider`,
        })
        return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
          assertObjectContains(headers, { host: `127.0.0.1:${agent.port}` })
          assert.ok(Array.isArray(payload))
          assert.strictEqual(checkSpansForServiceName(payload, 'next.request'), true)
        }, undefined, undefined, true)
      }).timeout(300 * 1000)
    }
  })
})
