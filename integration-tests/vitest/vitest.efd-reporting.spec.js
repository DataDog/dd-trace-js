'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')

const {
  getCiVisAgentlessConfig,
  sandboxCwd,
  useSandbox,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  TEST_FINAL_STATUS,
  TEST_IS_RETRY,
  TEST_STATUS,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { NODE_MAJOR } = require('../../version')

const vitest4Describe = NODE_MAJOR <= 18 ? describe.skip : describe

vitest4Describe('vitest@4.1.9 EFD reporting with the legacy module runner', () => {
  let cwd, receiver, childProcess, testOutput

  useSandbox(['vitest@4.1.9'], true)

  before(() => {
    cwd = sandboxCwd()
  })

  beforeEach(async () => {
    testOutput = ''
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(async () => {
    childProcess?.kill()
    await receiver?.stop()
  })

  it('reports a deterministic failure after all EFD attempts fail', async function () {
    this.timeout(60_000)

    receiver.setSettings({
      early_flake_detection: {
        enabled: true,
        slow_test_retries: {
          '5s': 3,
        },
      },
      known_tests_enabled: true,
    })
    receiver.setKnownTests({ vitest: {} })

    childProcess = exec(
      './node_modules/.bin/vitest run --config vitest.efd-reporting.config.mjs',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
        },
      }
    )
    childProcess.stdout.on('data', data => { testOutput += data })
    childProcess.stderr.on('data', data => { testOutput += data })

    const payloadsPromise = receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url === '/api/v2/citestcycle',
      payloads => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)
        const testSession = events.find(event => event.type === 'test_session_end').content
        const finalTest = tests.find(test => TEST_FINAL_STATUS in test.meta)

        assert.ok(tests.length > 0, testOutput)
        assert.ok(tests.some(test => test.meta[TEST_IS_RETRY] === 'true'), testOutput)
        assert.ok(finalTest, testOutput)
        assert.strictEqual(finalTest.meta[TEST_STATUS], 'fail', testOutput)
        assert.strictEqual(finalTest.meta[TEST_FINAL_STATUS], 'fail', testOutput)
        assert.strictEqual(testSession.meta[TEST_STATUS], 'fail', testOutput)
      }
    )

    const [[code, signal]] = await Promise.all([
      once(childProcess, 'exit'),
      payloadsPromise,
    ])

    assert.strictEqual(signal, null, testOutput)
    assert.strictEqual(code, 1, testOutput)

    const report = JSON.parse(fs.readFileSync(path.join(cwd, 'efd-results.json'), 'utf8'))
    const assertionResults = report.testResults.flatMap(({ assertionResults }) => assertionResults)

    assert.strictEqual(report.success, false)
    assert.strictEqual(assertionResults.length, 1)
    assert.strictEqual(assertionResults[0].status, 'failed')
    assert.ok(assertionResults[0].failureMessages.length > 0)
  })
})
