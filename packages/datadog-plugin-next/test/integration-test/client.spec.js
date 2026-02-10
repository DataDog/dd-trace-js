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
      const buildEnv = {
        ...process.env,
      }
      // --openssl-legacy-provider is not allowed in Node 24+
      if (NODE_MAJOR < 24) {
        buildEnv.NODE_OPTIONS = '--openssl-legacy-provider'
      }
      execSync('yarn exec next build', {
        cwd: sandboxCwd(),
        env: buildEnv,
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
        // --openssl-legacy-provider is not allowed in Node 24+
        const nodeOptions = NODE_MAJOR < 24
          ? `--loader=${hookFile} --require dd-trace/init --openssl-legacy-provider`
          : `--loader=${hookFile} --require dd-trace/init`
        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port, {
          NODE_OPTIONS: nodeOptions,
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
