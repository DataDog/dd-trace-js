'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { exec } = require('child_process')
const { inspect } = require('node:util')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  TEST_IS_TEST_FRAMEWORK_WORKER,
  TEST_NAME,
  TEST_STATUS,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { NODE_MAJOR } = require('../../version')

// vitest@4.x requires Node.js >= 20. The no-worker-init path relies on the
// latest Vitest reporter callbacks and setup-file behavior.
const versions = NODE_MAJOR <= 18 ? [] : ['latest']

versions.forEach((version) => {
  describe(`vitest@${version} no-worker init`, () => {
    let cwd, receiver, childProcess, testOutput

    useSandbox([
      `vitest@${version}`,
      'tinypool',
    ], true)

    before(function () {
      cwd = sandboxCwd()
    })

    beforeEach(async function () {
      testOutput = ''
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      childProcess.kill()
      await receiver.stop()
    })

    for (const poolConfig of ['forks', 'threads']) {
      it(`runs and reports tests without initializing dd-trace in ${poolConfig} workers`, async () => {
        const payloadsPromise = receiver.gatherPayloadsMaxTimeout(
          ({ url }) => url === '/api/v2/citestcycle',
          payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSessionEvents = events.filter(event => event.type === 'test_session_end')
            const testModuleEvents = events.filter(event => event.type === 'test_module_end')
            const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
            const testEvents = events.filter(event => event.type === 'test')

            assert.strictEqual(testSessionEvents.length, 1, inspect(events.map(event => event.type)))
            assert.strictEqual(testModuleEvents.length, 1, inspect(events.map(event => event.type)))
            assert.strictEqual(testSuiteEvents.length, 1, inspect(events.map(event => event.type)))
            assert.strictEqual(testEvents.length, 1, inspect(events.map(event => event.type)))
            assert.strictEqual(testEvents[0].content.meta[TEST_NAME], 'vitest worker env sets DD_VITEST_WORKER')
            assert.strictEqual(testEvents[0].content.meta[TEST_STATUS], 'pass')
            assert.strictEqual(testEvents[0].content.meta[TEST_IS_TEST_FRAMEWORK_WORKER], 'true')
          }
        )

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--no-warnings --import dd-trace/register.js -r dd-trace/ci/init',
              TEST_DIR: 'ci-visibility/vitest-tests/vitest-worker-env.mjs',
              POOL_CONFIG: poolConfig,
              DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: 'true',
              EXPECT_DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE: '1',
              EXPECT_NO_DD_TRACE_INIT: '1',
              DD_SERVICE: undefined,
            },
          }
        )

        childProcess.stdout.on('data', data => { testOutput += data })
        childProcess.stderr.on('data', data => { testOutput += data })

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          payloadsPromise,
        ])

        assert.strictEqual(exitCode, 0, testOutput)
      })
    }
  })
})
