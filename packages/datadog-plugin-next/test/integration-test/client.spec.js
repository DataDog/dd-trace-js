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

const hookFile = 'dd-trace/loader-hook.mjs'
const nodeMajor = parseInt(process.versions.node.split('.')[0])

describe('esm', () => {
  let agent
  let proc
  let sandbox
  let variants
  // match versions tested with unit tests
  if (process.env.PACKAGE_VERSION_RANGE === '>=11.0.0 <13' && nodeMajor >= 25) {
    return
  }
  withVersions('next', 'next', '>=11.1 <15.4.1', version => {
    // These next versions have a dependency which uses a depricated node buffer
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
