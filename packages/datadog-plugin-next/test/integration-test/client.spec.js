'use strict'

const {
  FakeAgent,
  createSandbox,
  curlAndAssertMessage,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
  varySandbox
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { assert } = require('chai')
const { NODE_MAJOR } = require('../../../../version')

const hookFile = 'dd-trace/loader-hook.mjs'
const min = NODE_MAJOR >= 25 ? '>=13' : '>=11.1'

describe('esm', () => {
  let agent
  let proc
  let sandbox
  let variants

  // These next versions have a dependency which uses a deprecated node buffer and match versions tested with unit tests
  withVersions('next', 'next', `${min} <15.4.1`, version => {
    before(async function () {
      // next builds slower in the CI, match timeout with unit tests
      this.timeout(300 * 1000)
      sandbox = await createSandbox([`'next@${version}'`, 'react@^18.2.0', 'react-dom@^18.2.0'],
        false, ['./packages/datadog-plugin-next/test/integration-test/*'],
        'NODE_OPTIONS=--openssl-legacy-provider yarn exec next build')
      variants = varySandbox(sandbox, 'server.mjs', 'next')
    })

    after(async () => {
      await sandbox.remove()
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
        proc = await spawnPluginIntegrationTestProc(sandbox.folder, variants[variant], agent.port, undefined, {
          NODE_OPTIONS: `--loader=${hookFile} --require dd-trace/init --openssl-legacy-provider`
        })
        return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(checkSpansForServiceName(payload, 'next.request'), true)
        }, undefined, undefined, true)
      }).timeout(300 * 1000)
    }
  })
})
