'use strict'

const {
  FakeAgent,
  createSandbox,
  curlAndAssertMessage,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')
const { DD_MAJOR } = require('../../../../version')

const hookFile = 'dd-trace/loader-hook.mjs'

describe('esm', () => {
  let agent
  let proc
  let sandbox

  withVersions('next', 'next', DD_MAJOR >= 4 && '>=11', version => {
<<<<<<< HEAD
<<<<<<< HEAD
    // skip any semver incompatible versions
=======
>>>>>>> 8f704e9fd (address feedback)
    before(async function () {
      // next builds slower in the CI, match timeout with unit tests
      this.timeout(120 * 1000)
      sandbox = await createSandbox([`'next@${version}'`, 'react', 'react-dom'],
        false, ['./packages/datadog-plugin-next/test/integration-test/*'], 'yarn exec next build')
<<<<<<< HEAD
=======
    describe('next', () => {
      before(async function () {
        // next builds slower in the CI, match timeout with unit tests
        this.timeout(120 * 1000)
        sandbox = await createSandbox([`'next@${version}'`, 'react', 'react-dom'],
          false, ['./packages/datadog-plugin-next/test/integration-test/*'], 'yarn exec next build')
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

      it('is instrumented', async () => {
        proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

        return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(checkSpansForServiceName(payload, 'next.request'), true)
        })
      }).timeout(120 * 1000)
>>>>>>> 8f1aa2fc4 (address feedback)
=======
>>>>>>> 8f704e9fd (address feedback)
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

    it('is instrumented', async () => {
<<<<<<< HEAD
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port, undefined, {
        NODE_OPTIONS: `--loader=${hookFile} --require dd-trace/init`
      })
=======
      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

>>>>>>> 8f704e9fd (address feedback)
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'next.request'), true)
<<<<<<< HEAD
      }, undefined, undefined, true)
=======
      })
>>>>>>> 8f704e9fd (address feedback)
    }).timeout(120 * 1000)
  })
})
