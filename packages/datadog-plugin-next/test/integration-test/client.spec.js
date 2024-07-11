'use strict'

const {
  FakeAgent,
  createSandbox,
  curlAndAssertMessage,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')
const { NODE_MAJOR } = require('../../../../version')

const hookFile = 'dd-trace/loader-hook.mjs'

const BUILD_COMMAND = NODE_MAJOR < 18
  ? 'yarn exec next build'
  : 'NODE_OPTIONS=--openssl-legacy-provider yarn exec next build'
const NODE_OPTIONS = NODE_MAJOR < 18
  ? `--loader=${hookFile} --require dd-trace/init`
  : `--loader=${hookFile} --require dd-trace/init --openssl-legacy-provider`

const VERSIONS_TO_TEST = NODE_MAJOR < 18 ? '>=11.1 <13.2' : '>=11.1'

describe('esm', () => {
  let agent
  let proc
  let sandbox
  // match versions tested with unit tests
  withVersions('next', 'next', VERSIONS_TO_TEST, version => {
    before(async function () {
      sandbox = await createSandbox([`'next@${version}'`, 'react', 'react-dom'],
        false, ['./packages/datadog-plugin-next/test/integration-test/*'],
        BUILD_COMMAND)
    }, { timeout: 240000 }) // next builds slower in the CI, match timeout with unit tests

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

    it('is instrumented', async () => {
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port, undefined, {
        NODE_OPTIONS
      })
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'next.request'), true)
      }, undefined, undefined, true)
    }).timeout(120 * 1000)
  })
})
