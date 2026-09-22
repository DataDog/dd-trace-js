'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')

const { getCiVisAgentlessConfig } = require('../helpers')
const {
  TEST_FINAL_STATUS,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_NAME,
  TEST_RETRY_REASON,
  TEST_RETRY_REASON_TYPES,
  TEST_STATUS,
} = require('../../packages/dd-trace/src/plugins/util/test')

const testSuite = 'ci-visibility/vitest-tests/dynamic-atr.mjs'

/**
 * Register shared retry regressions using the parent suite's sandbox, intake, and process cleanup.
 *
 * @param {object} options
 * @param {string} options.mode
 * @param {boolean} options.supportsDynamicAtr
 * @param {() => {
 *   cwd: string,
 *   receiver: import('../ci-visibility-intake').FakeCiVisIntake,
 *   env: Record<string, string | undefined>,
 *   onChildProcess: (child: import('node:child_process').ChildProcess) => void
 * }} options.getContext
 */
function describeDynamicAtr ({ mode, supportsDynamicAtr, getContext }) {
  describe('dynamic ATR', function () {
    this.timeout(120_000)
    let output

    beforeEach(() => {
      output = ''
      getContext().receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        flaky_test_retries_enabled: true,
        early_flake_detection: { enabled: false },
      })
    })

    async function run (pattern = '', { env, command } = {}) {
      const { cwd, receiver, env: modeEnv, onChildProcess } = getContext()
      const childProcess = exec(
        command || './node_modules/.bin/vitest run --reporter=default --reporter=json' +
        ' --outputFile=dynamic-atr-results.json' + (pattern ? ` -t "${pattern}"` : ''),
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: testSuite,
            DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED: 'true',
            DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: '1,2,3,4,5',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '3',
            ...modeEnv,
            ...env,
          },
        }
      )
      onChildProcess(childProcess)
      childProcess.stdout.on('data', data => { output += data })
      childProcess.stderr.on('data', data => { output += data })
      let payloads
      const [[code]] = await Promise.all([
        once(childProcess, 'exit'),
        receiver.gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url === '/api/v2/citestcycle',
          received => { payloads = received }
        ),
      ]).catch(error => { throw new Error(output, { cause: error }) })
      const report = command
        ? undefined
        : JSON.parse(fs.readFileSync(path.join(cwd, 'dynamic-atr-results.json'), 'utf8'))
      const tests = payloads.flatMap(({ payload }) => payload.events)
        .filter(event => event.type === 'test').map(event => event.content)
      return { code, tests, report }
    }

    it(`bounds complete attempts and preserves final results in ${mode}`, async () => {
      const { code, tests, report } = await run()
      assert.strictEqual(code, 1, output)
      const countsMatch = output.match(/DYNAMIC_ATR_COUNTS (\{[^\n]+\})/)
      assert.ok(countsMatch, output)
      const counts = JSON.parse(countsMatch[1])
      const attempts = supportsDynamicAtr ? 2 : 4
      for (const failure of ['body', 'beforeEach', 'afterEach', 'fixture']) {
        // Vitest 1/3 retain fixtures after failed cleanup; throwing teardown clears the value every second attempt.
        const fixtureSetups = supportsDynamicAtr ? attempts : ({ afterEach: 1, fixture: 2 }[failure] ?? attempts)
        assert.deepStrictEqual(counts[failure], {
          beforeEach: attempts,
          body: failure === 'beforeEach' ? 0 : attempts,
          afterEach: attempts,
          fixture: failure === 'beforeEach' ? 0 : fixtureSetups,
        }, `${mode}: ${failure}`)
        const events = tests.filter(test => test.meta[TEST_NAME] === `${failure} failure`)
        assert.strictEqual(events.length, attempts, `${mode}: ${failure} spans`)
        assert.ok(events.every(test => test.meta[TEST_STATUS] === 'fail'))
        const final = events.filter(test => test.meta[TEST_FINAL_STATUS] === 'fail')
        assert.strictEqual(final.length, 1)
        assert.strictEqual(final[0].meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
        // The legacy runner retries the retained rejected cleanup promise on its final attempt.
        const failureCount = failure === 'fixture' && !supportsDynamicAtr ? 1 : attempts
        assert.strictEqual(final[0].meta['error.message'], `${failure} failure ${failureCount}`)
        assert.ok(events.slice(1).every(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr))
      }
      assert.strictEqual(counts.expectedFailure, attempts)
      assert.strictEqual(counts.unexpectedPass, 1)
      assert.strictEqual(counts.eventuallyPasses, 2)
      assert.strictEqual(counts.slow, supportsDynamicAtr ? 3 : 4)
      const results = report.testResults.flatMap(result => result.assertionResults)
      assert.strictEqual(results.find(test => test.title === 'expected failure').status, 'passed')
      assert.strictEqual(results.find(test => test.title === 'unexpected pass').status, 'failed')
      assert.strictEqual(results.find(test => test.title === 'eventually passes').status, 'passed')
    })

    if (!supportsDynamicAtr) return

    it(`measures each native repetition independently in ${mode}`, async () => {
      const { code, report } = await run('', {
        env: { TEST_DIR: 'ci-visibility/vitest-tests/dynamic-atr-repeats.mjs' },
      })
      assert.strictEqual(code, 1, output)
      const counts = output.match(/DYNAMIC_ATR_REPEATS (\{[^\n]+\})/)
      assert.ok(counts, output)
      assert.deepStrictEqual(JSON.parse(counts[1]), {
        'slow pass then fast fail': [1, 2],
        'fast fail then slow fail': [2, 3],
        'slow fail then fast fail': [3, 2],
      })
      assert.ok(report.testResults.flatMap(result => result.assertionResults).every(test => test.status === 'failed'))
    })

    it(`preserves explicit test and suite retries in ${mode}`, async () => {
      const { code, tests, report } = await run('', {
        env: { TEST_DIR: 'ci-visibility/vitest-tests/dynamic-atr-overrides.mjs' },
      })
      assert.strictEqual(code, 1, output)
      const expectedAttempts = {
        inherited: 2,
        'retry 0': 1,
        'retry 2': 3,
        'retry 5': 6,
        'retry 8': 9,
        'suite override failure': 6,
        'object override': 3,
        'eventual override': 3,
      }
      for (const [name, count] of Object.entries(expectedAttempts)) {
        const attempts = tests.filter(test => test.meta[TEST_NAME] === name)
        assert.strictEqual(attempts.length, count, `${name}: ${output}`)
        const reason = name === 'inherited' ? TEST_RETRY_REASON_TYPES.atr : TEST_RETRY_REASON_TYPES.ext
        assert.ok(attempts.slice(1).every(test => test.meta[TEST_RETRY_REASON] === reason), name)
      }
      const results = report.testResults.flatMap(result => result.assertionResults)
      assert.strictEqual(results.find(test => test.title === 'eventual override').status, 'passed')
    })

    it(`uses real elapsed time with fake timers in ${mode}`, async () => {
      const { code, tests } = await run('', {
        env: {
          TEST_DIR: 'ci-visibility/vitest-tests/dynamic-atr-fake-timers.mjs',
          VITEST_SETUP_FILE: 'ci-visibility/vitest-tests/fake-timers-setup.mjs',
        },
      })
      assert.strictEqual(code, 1, output)
      assert.strictEqual(tests.length, 2, output)
      assert.strictEqual(tests[1].meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
      assert.strictEqual(tests[1].meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.atr)
    })

    it(`retains retry ownership across programmatic runs in ${mode}`, async () => {
      const { code, tests } = await run('', {
        command: 'node ci-visibility/vitest-tests-programmatic-api/run-dynamic-atr-rerun.mjs',
        env: { TEST_DIR: 'ci-visibility/vitest-tests-programmatic-api/dynamic-atr-*.mjs' },
      })
      assert.strictEqual(code, 1, output)
      const results = output.match(/DYNAMIC_ATR_RERUNS (\[[^\n]+\])/)
      assert.ok(results, output)
      assert.deepStrictEqual(JSON.parse(results[1]), [1, 1, 4])
      assert.strictEqual(tests.length, 9, output)
      assert.strictEqual(tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr).length, 2)
      assert.strictEqual(tests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.ext).length, 4)
    })

    it(`keeps exhausted quarantined failures successful in ${mode}`, async () => {
      const { receiver } = getContext()
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        flaky_test_retries_enabled: true,
        early_flake_detection: { enabled: false },
        test_management: { enabled: true },
      })
      receiver.setTestManagementTests({
        vitest: {
          suites: {
            [testSuite]: {
              tests: Object.fromEntries(['body', 'beforeEach', 'afterEach', 'fixture'].map(failure => [
                `${failure} failure`, { properties: { quarantined: true } },
              ])),
            },
          },
        },
      })
      const { code, tests } = await run('body|beforeEach|afterEach|fixture')
      assert.strictEqual(code, 0, output)
      for (const failure of ['body', 'beforeEach', 'afterEach', 'fixture']) {
        const attempts = tests.filter(test => test.meta[TEST_NAME] === `${failure} failure`)
        assert.strictEqual(attempts.length, 2, output)
        assert.strictEqual(attempts[1].meta[TEST_FINAL_STATUS], 'skip')
        assert.strictEqual(attempts[1].meta[TEST_STATUS], 'fail')
      }
    })
  })
}

module.exports = { describeDynamicAtr }
