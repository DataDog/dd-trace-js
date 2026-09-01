'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const {
  FakeAgent,
  ProcessTimeoutError,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProcAndExpectExit,
  varySandbox,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

const processAttempts = 2
const processTimeoutMs = 5_000

describe('esm', () => {
  let agent
  let proc

  /**
   * @param {string} serverFile
   * @param {number} agentPort
   */
  async function runInstrumentedProcess (serverFile, agentPort) {
    for (let attempt = 0; attempt < processAttempts; attempt++) {
      const spawned = spawnPluginIntegrationTestProcAndExpectExit(
        sandboxCwd(),
        serverFile,
        agentPort,
        undefined,
        undefined,
        undefined,
        processTimeoutMs
      )
      proc = spawned.proc

      try {
        await spawned.completed
        return
      } catch (error) {
        if (!(error instanceof ProcessTimeoutError) || attempt === processAttempts - 1) throw error
      }
    }
  }

  withVersions('oracledb', 'oracledb', version => {
    useSandbox([`'oracledb@${version}'`], false, [
      './packages/datadog-plugin-oracledb/test/integration-test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    const variants = varySandbox('server.mjs', {
      bindingName: 'oracledb',
      packageName: 'oracledb',
      defaultExport: true,
      namedExports: [],
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of Object.keys(variants)) {
      it(`is instrumented ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'oracle.query'), true)
        })

        await runInstrumentedProcess(variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})
