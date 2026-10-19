'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')

const { sandboxCwd, useSandbox, getCiVisAgentlessConfig, stopCiVisTestEnv } = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { NODE_MAJOR } = require('../../version')
const protection = 'test.test_management.prevent_failure_suppression'
const exclusion = 'test.test_management.no_auto_retry'
const suite = 'ci-visibility/vitest-tests/test-exclusions.mjs'

const versions = NODE_MAJOR <= 18 ? ['1.6.0', '3.2.6'] : ['3.2.6', 'latest']

for (const version of versions) {
  describe(`Vitest ${version} no-worker automation exclusions`, function () {
    this.timeout(120000)
    useSandbox([
      `vitest@${version}`, `@vitest/coverage-istanbul@${version}`, `@vitest/coverage-v8@${version}`, 'tinypool',
    ], true)
    let cwd, receiver, childProcess
    before(() => { cwd = sandboxCwd() })
    beforeEach(async () => { receiver = await new FakeCiVisIntake().start() })
    afterEach(async () => {
      await stopCiVisTestEnv({ childProcess, receiver })
      childProcess = undefined
    })
    const properties = assignments => {
      receiver.setTestManagementTests({ vitest: { suites: { [suite]: { tests: assignments } } } })
    }
    const run = async (mode, expectedExit, check, env = {}) => {
      childProcess = exec('./node_modules/.bin/vitest run', {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
          DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: 'true',
          TEST_DIR: suite,
          EXCLUSIONS_MODE: mode,
          DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '2',
          ...env,
        },
      })
      let output = ''
      childProcess.stdout.on('data', chunk => { output += chunk })
      childProcess.stderr.on('data', chunk => { output += chunk })
      const exitPromise = once(childProcess, 'exit')
      const eventsPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        payloads => {
          const tests = payloads.flatMap(({ payload }) => payload.events)
            .filter(event => event.type === 'test').map(event => event.content)
          assert.ok(tests.length, output)
          check(tests)
        },
        { hardTimeout: 90000 }
      )
      const [[exitCode]] = await Promise.all([exitPromise, eventsPromise]).catch(error => {
        error.message += `\nVitest output:\n${output}`
        throw error
      })
      assert.strictEqual(exitCode, expectedExit, output)
    }
    const named = (tests, name) => tests.filter(test => test.meta['test.name'] === name)

    it('protects failures and retains assignments, parameterized declarations and skipped annotations', async () => {
      receiver.setSettings({ test_management: { enabled: true }, flaky_test_retries_enabled: false })
      const protectedNames = ['protected disabled', 'protected quarantine', 'protected both 1', 'protected both 2']
      // The first two tests allow ATF; omit that assignment so each executes once.
      const assignments = Object.fromEntries(protectedNames.map(name => [name, {
        properties: {
          disabled: true, quarantined: true, ...(name.startsWith('protected both') ? { attempt_to_fix: true } : {}),
        },
      }]))
      assignments['protected passing'] = { properties: { disabled: true, quarantined: true } }
      assignments['ordinary disabled'] = { properties: { disabled: true, attempt_to_fix: true } }
      assignments['ordinary quarantine'] = { properties: { quarantined: true } }
      properties(assignments)
      await run('policy', 1, tests => {
        assert.strictEqual(tests.length, 8)
        for (const name of protectedNames) {
          const [test] = named(tests, name)
          assert.strictEqual(test.meta['test.status'], 'fail', name)
          assert.strictEqual(test.meta['test.final_status'], 'fail', name)
          assert.strictEqual(test.meta[protection], 'true', name)
          assert.strictEqual(test.meta['test.test_management.is_test_disabled'], 'true', name)
          assert.strictEqual(test.meta['test.test_management.is_quarantined'], 'true', name)
          assert.strictEqual(test.meta['test.is_retry'], undefined, name)
          if (name.startsWith('protected both')) {
            assert.strictEqual(test.meta[exclusion], 'true', name)
            assert.strictEqual(test.meta['test.test_management.is_attempt_to_fix'], 'true', name)
            assert.strictEqual(test.meta['test.test_management.attempt_to_fix_passed'], undefined, name)
          }
        }
        assert.strictEqual(named(tests, 'ordinary disabled')[0].meta['test.status'], 'skip')
        assert.strictEqual(named(tests, 'ordinary disabled')[0].meta[exclusion], 'true')
        assert.strictEqual(named(tests, 'ordinary disabled')[0].meta['test.test_management.is_attempt_to_fix'], 'true')
        assert.strictEqual(named(tests, 'ordinary quarantine')[0].meta['test.final_status'], 'skip')
        assert.strictEqual(named(tests, 'protected passing')[0].meta['test.status'], 'pass')
        const [skipped] = named(tests, 'developer skipped')
        assert.strictEqual(skipped.meta['test.status'], 'skip')
        assert.strictEqual(skipped.meta[protection], 'true')
        assert.strictEqual(skipped.meta[exclusion], 'true')
      })
    })

    it('blocks ATR without preventing protected retries or changing unannotated controls', async () => {
      receiver.setSettings({ flaky_test_retries_enabled: true })
      await run('atr', 1, tests => {
        assert.strictEqual(tests.length, 6)
        const [excluded] = named(tests, 'excluded')
        assert.strictEqual(named(tests, 'excluded').length, 1)
        assert.strictEqual(excluded.meta[exclusion], 'true')
        assert.strictEqual(excluded.meta['test.is_retry'], undefined)
        assert.strictEqual(named(tests, 'control').length, 3)
        assert.strictEqual(named(tests, 'protected retry').length, 2)
        assert.strictEqual(named(tests, 'protected retry').at(-1).meta['test.status'], 'pass')
      })
    })

    for (const feature of ['efd', 'atf']) {
      it(`blocks ${feature} while preserving discovery and assigned properties`, async () => {
        receiver.setSettings({
          flaky_test_retries_enabled: false,
          known_tests_enabled: feature === 'efd',
          early_flake_detection: {
            enabled: feature === 'efd', slow_test_retries: { '5s': 2 }, faulty_session_threshold: 100,
          },
          test_management: { enabled: feature === 'atf', attempt_to_fix_retries: 2 },
        })
        receiver.setKnownTests({ vitest: { 'ci-visibility/vitest-tests/known.mjs': ['known'] } })
        properties({
          excluded: { properties: { attempt_to_fix: true } },
          control: { properties: { attempt_to_fix: true } },
        })
        await run(feature, 0, tests => {
          assert.strictEqual(tests.length, 4)
          const [excluded] = named(tests, 'excluded')
          assert.strictEqual(named(tests, 'excluded').length, 1)
          assert.strictEqual(named(tests, 'control').length, 3)
          assert.strictEqual(excluded.meta[exclusion], 'true')
          assert.strictEqual(excluded.meta['test.is_retry'], undefined)
          assert.strictEqual(excluded.meta['test.test_management.attempt_to_fix_passed'], undefined)
          if (feature === 'efd') assert.strictEqual(excluded.meta['test.is_new'], 'true')
          if (feature === 'atf') assert.strictEqual(excluded.meta['test.test_management.is_attempt_to_fix'], 'true')
        })
      })
    }

    it('preserves explicit native retries without attributing them to Datadog ATR', async () => {
      receiver.setSettings({ flaky_test_retries_enabled: true })
      await run('explicit', 0, tests => {
        assert.strictEqual(tests.length, 2)
        for (const test of tests) assert.strictEqual(test.meta[exclusion], 'true')
        assert.strictEqual(tests[1].meta['test.retry_reason'], 'external')
        assert.strictEqual(tests[1].meta['test.status'], 'pass')
      })
    })
    it('keeps a sole protected failure blocking with all management assignments', async () => {
      receiver.setSettings({ test_management: { enabled: true }, flaky_test_retries_enabled: true })
      properties({ sole: { properties: { disabled: true, quarantined: true, attempt_to_fix: true } } })
      await run('sole', 1, tests => {
        assert.strictEqual(tests.length, 1)
        assert.strictEqual(tests[0].meta['test.status'], 'fail')
        assert.strictEqual(tests[0].meta['test.final_status'], 'fail')
        assert.strictEqual(tests[0].meta[protection], 'true')
        assert.strictEqual(tests[0].meta[exclusion], 'true')
      })
    })

    it('restores quarantine policy and omits observation tags when annotations are removed', async () => {
      receiver.setSettings({ test_management: { enabled: true }, flaky_test_retries_enabled: false })
      properties({ sole: { properties: { quarantined: true } } })
      await run('removed', 0, tests => {
        assert.strictEqual(tests.length, 1)
        assert.strictEqual(tests[0].meta['test.status'], 'fail')
        assert.strictEqual(tests[0].meta['test.final_status'], 'skip')
        assert.strictEqual(tests[0].meta[protection], undefined)
        assert.strictEqual(tests[0].meta[exclusion], undefined)
      })
    })

    it('preserves explicit suite retries for excluded callbacks', async () => {
      receiver.setSettings({ flaky_test_retries_enabled: true })
      await run('native-suite', 0, tests => {
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(tests[1].meta['test.status'], 'pass')
        assert.strictEqual(tests[1].meta[exclusion], 'true')
        assert.strictEqual(tests[1].meta['test.retry_reason'], 'external')
      })
    })

    it('preserves annotations across concurrent parameterized declaration chains', async () => {
      receiver.setSettings({ flaky_test_retries_enabled: true })
      await run('concurrent', 1, tests => {
        assert.strictEqual(tests.length, 5)
        for (const name of ['excluded 1', 'excluded 2']) {
          const attempts = named(tests, name)
          assert.strictEqual(attempts.length, 1)
          assert.strictEqual(attempts[0].meta[exclusion], 'true')
          assert.strictEqual(attempts[0].meta['test.is_retry'], undefined)
        }
        assert.strictEqual(named(tests, 'control').length, 3)
      })
    })
    // Vitest 1.6 supports numeric retry counts only; the current runner also supports retry conditions.
    const conditionalRetryIt = version === 'latest' ? it : it.skip
    conditionalRetryIt('preserves explicit native conditional retries without serializing their function', async () => {
      receiver.setSettings({ flaky_test_retries_enabled: true })
      await run('native-condition', 0, tests => {
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(tests[1].meta['test.status'], 'pass')
        assert.strictEqual(tests[1].meta[exclusion], 'true')
        assert.strictEqual(tests[1].meta['test.retry_reason'], 'external')
      })
    })
  })
}
