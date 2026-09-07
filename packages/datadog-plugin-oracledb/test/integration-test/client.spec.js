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
   * @param {() => ReturnType<typeof spawnPluginIntegrationTestProcAndExpectExit>} [spawnProcess]
   */
  async function runInstrumentedProcess (
    serverFile,
    agentPort,
    spawnProcess = () => spawnPluginIntegrationTestProcAndExpectExit(
      sandboxCwd(),
      serverFile,
      agentPort,
      undefined,
      undefined,
      undefined,
      processTimeoutMs
    )
  ) {
    for (let attempt = 0; attempt < processAttempts; attempt++) {
      const completed = spawnProcess()
      proc = completed.proc

      try {
        await completed
        return
      } catch (error) {
        if (!(error instanceof ProcessTimeoutError) || attempt === processAttempts - 1) throw error
      }
    }
  }

  it('retries a timed out process once', async () => {
    const procs = []

    function spawnProcess () {
      const child = /** @type {ReturnType<typeof spawnPluginIntegrationTestProcAndExpectExit>['proc']} */ ({})
      const completed = /** @type {ReturnType<typeof spawnPluginIntegrationTestProcAndExpectExit>} */ (
        procs.length === 0 ? Promise.reject(new ProcessTimeoutError(processTimeoutMs)) : Promise.resolve()
      )
      completed.proc = child
      procs.push(child)
      return completed
    }

    try {
      await runInstrumentedProcess('unused', 0, spawnProcess)

      assert.strictEqual(procs.length, processAttempts)
      assert.notStrictEqual(procs[0], procs[1])
      assert.strictEqual(proc, procs[1])
    } finally {
      proc = undefined
    }
  })

  it('does not retry other process errors', async () => {
    const expectedError = new Error('unexpected process error')
    let attempts = 0

    function spawnProcess () {
      attempts++
      const completed = /** @type {ReturnType<typeof spawnPluginIntegrationTestProcAndExpectExit>} */ (
        Promise.reject(expectedError)
      )
      completed.proc = /** @type {ReturnType<typeof spawnPluginIntegrationTestProcAndExpectExit>['proc']} */ ({})
      return completed
    }

    try {
      await assert.rejects(runInstrumentedProcess('unused', 0, spawnProcess), expectedError)
      assert.strictEqual(attempts, 1)
    } finally {
      proc = undefined
    }
  })

  it('rejects after the second timed out process', async () => {
    const procs = []

    function spawnProcess () {
      const child = /** @type {ReturnType<typeof spawnPluginIntegrationTestProcAndExpectExit>['proc']} */ ({})
      const completed = /** @type {ReturnType<typeof spawnPluginIntegrationTestProcAndExpectExit>} */ (
        Promise.reject(new ProcessTimeoutError(processTimeoutMs))
      )
      completed.proc = child
      procs.push(child)
      return completed
    }

    try {
      await assert.rejects(runInstrumentedProcess('unused', 0, spawnProcess), {
        code: 'ERR_PROCESS_TIMEOUT',
      })
      assert.strictEqual(procs.length, processAttempts)
      assert.notStrictEqual(procs[0], procs[1])
      assert.strictEqual(proc, procs[1])
    } finally {
      proc = undefined
    }
  })

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
        const messageReceived = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'oracle.query'), true)
        })

        await Promise.all([
          runInstrumentedProcess(variants[variant], agent.port),
          messageReceived,
        ])
      }).timeout(20000)
    }
  })
})
