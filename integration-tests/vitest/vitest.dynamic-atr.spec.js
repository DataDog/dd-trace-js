'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')

const {
  getCiVisAgentlessConfig,
  installPlaywrightChromium,
  sandboxCwd,
  useSandbox,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { getLatestPlaywrightSpecifier } = require('../playwright/versions')
const {
  TEST_FINAL_STATUS,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_NAME,
  TEST_RETRY_REASON,
  TEST_RETRY_REASON_TYPES,
  TEST_STATUS,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { NODE_MAJOR } = require('../../version')

const testSuite = 'ci-visibility/vitest-tests/dynamic-atr.mjs'
const versions = NODE_MAJOR <= 18 ? ['1.6.0', '3.2.6'] : ['1.6.0', '3.2.6', '4.1.0', 'latest']

for (const version of versions) {
  describe(`vitest@${version} dynamic ATR`, function () {
    this.timeout(120_000)
    const supportsDynamicAtr = version === 'latest' || version === '4.1.0'
    const dependencies = [`vitest@${version}`]
    if (supportsDynamicAtr) {
      const browserVersion = version === 'latest'
        ? require('../../packages/dd-trace/test/plugins/versions/package.json').dependencies.vitest
        : version
      dependencies.push(`@vitest/browser-playwright@${browserVersion}`, `playwright@${getLatestPlaywrightSpecifier()}`)
    }
    useSandbox(dependencies, true)

    let cwd, receiver, childProcess, output
    before(() => {
      cwd = sandboxCwd()
      if (supportsDynamicAtr) installPlaywrightChromium(cwd)
    })
    beforeEach(async () => {
      output = ''
      receiver = await new FakeCiVisIntake().start()
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
        flaky_test_retries_enabled: true,
        early_flake_detection: { enabled: false },
      })
    })
    afterEach(async () => {
      childProcess?.kill()
      await receiver.stop()
    })

    async function run (mode, pattern = '') {
      childProcess = exec(
        './node_modules/.bin/vitest run --reporter=default --reporter=json --outputFile=dynamic-atr-results.json' +
        (pattern ? ` -t "${pattern}"` : ''),
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: testSuite,
            DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED: 'true',
            DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: '1,2,3,4,5',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '3',
            DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: mode === 'no-worker' ? 'true' : undefined,
            POOL_CONFIG: mode === 'threads' ? 'threads' : 'forks',
            VITEST_BROWSER_MODE: mode === 'browser' ? '1' : undefined,
            VITEST_BROWSER_PROVIDER_FACTORY: '1',
          },
        }
      )
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
      ])
      const report = JSON.parse(fs.readFileSync(path.join(cwd, 'dynamic-atr-results.json'), 'utf8'))
      const tests = payloads.flatMap(({ payload }) => payload.events)
        .filter(event => event.type === 'test').map(event => event.content)
      return { code, tests, report }
    }

    const modes = supportsDynamicAtr ? ['forks', 'threads', 'no-worker', 'browser'] : ['forks']
    if (version === '3.2.6') modes.push('no-worker')
    for (const mode of modes) {
      it(`bounds complete attempts and preserves final results in ${mode}`, async () => {
        const { code, tests, report } = await run(mode)
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

      if (!supportsDynamicAtr) continue

      it(`keeps exhausted quarantined failures successful in ${mode}`, async () => {
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
        const { code, tests } = await run(mode, 'body|beforeEach|afterEach|fixture')
        assert.strictEqual(code, 0, output)
        for (const failure of ['body', 'beforeEach', 'afterEach', 'fixture']) {
          const attempts = tests.filter(test => test.meta[TEST_NAME] === `${failure} failure`)
          assert.strictEqual(attempts.length, 2, output)
          assert.strictEqual(attempts[1].meta[TEST_FINAL_STATUS], 'skip')
          assert.strictEqual(attempts[1].meta[TEST_STATUS], 'fail')
        }
      })
    }
  })
}
