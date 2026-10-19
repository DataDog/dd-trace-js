'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')

const satisfies = require('semifies')

const { sandboxCwd, useSandbox, getCiVisAgentlessConfig } = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  TEST_NAME, TEST_STATUS, TEST_IS_RETRY, TEST_RETRY_REASON, TEST_RETRY_REASON_TYPES,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX, TEST_MANAGEMENT_IS_DISABLED, TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { oldest, getLatestPlaywrightSpecifier } = require('./versions')

const requested = process.env.PLAYWRIGHT_VERSION || 'latest'
const version = requested === 'oldest' ? oldest : requested === 'latest' ? getLatestPlaywrightSpecifier() : requested
// The root-suite policy hook and execution metadata are available from Playwright 1.38.
const supported = version === 'latest' || satisfies(version, '>=1.38.0')

describe(`Playwright automation exclusions@${version}`, () => {
  let receiver, child, cwd, output
  if (supported) {
    useSandbox([`@playwright/test@${version}`], true)
    before(() => { cwd = sandboxCwd() })
    beforeEach(async () => { receiver = await new FakeCiVisIntake().start(); output = '' })
    afterEach(async () => { child?.kill(); await receiver.stop() })
  }

  // The reusable config runner entry point used by this fixture is available from Playwright 1.60.
  const lifecycleIt = version === 'latest' || satisfies(version, '>=1.60.0') ? it : it.skip
  lifecycleIt('preserves native retries after disabling the plugin on a reused project', async () => {
    receiver.setSettings({ flaky_test_retries_enabled: true })
    child = exec('node ./ci-visibility/playwright-rerun-console.js', {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        NODE_OPTIONS: '',
        TEST_DIR: './ci-visibility/playwright-tests-exclusions-rerun',
        TEST_SHOULD_FAIL: 'true',
        PLAYWRIGHT_DISABLE_PLUGIN_BETWEEN_RUNS: '1',
        PLAYWRIGHT_NATIVE_RETRIES_AFTER_DISABLE: '2',
        DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '2',
      },
    })
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    const [exitCode] = await once(child, 'close')
    const [firstRun, secondRun] = output.split('PLAYWRIGHT_PLUGIN_DISABLED\n')
    assert.ok(secondRun, output)
    const executions = part => part.split('PLAYWRIGHT_EXCLUDED_TEST_EXECUTED\n').length - 1
    assert.strictEqual(executions(firstRun), 1, output)
    assert.strictEqual(executions(secondRun), 3, output)
    assert.strictEqual(exitCode, 0, output)
  })

  for (const mode of ['atr', 'efd', 'native']) {
    const run = supported ? it : it.skip
    run(`preserves ${mode} policy and assigned tags`, async () => {
      const assigned = {
        'combined one': { attempt_to_fix: true, disabled: true, quarantined: true },
        'combined two': { attempt_to_fix: true, disabled: true, quarantined: true },
        'quarantined exclusion': { attempt_to_fix: true, quarantined: true },
        'disabled exclusion': { attempt_to_fix: true, disabled: true },
        'protected retries': { disabled: true, quarantined: true },
        'protected attempt to fix': { attempt_to_fix: true, disabled: true, quarantined: true },
        'protected passing': { disabled: true },
        'ordinary control': {},
      }
      receiver.setSettings({
        flaky_test_retries_enabled: true,
        known_tests_enabled: mode === 'efd',
        early_flake_detection: {
          enabled: mode === 'efd', slow_test_retries: { '5s': 2 }, faulty_session_threshold: 100,
        },
        test_management: { enabled: true, attempt_to_fix_retries: 2 },
      })
      receiver.setKnownTests({ playwright: {} })
      receiver.setTestManagementTests({
        playwright: {
          suites: {
            'exclusions.test.js': {
              tests: Object.fromEntries(Object.entries(assigned).map(([name, properties]) => [name, { properties }])),
            },
          },
        },
      })
      child = exec('node node_modules/@playwright/test/cli.js test' +
        ' --config ci-visibility/playwright-automation-exclusions/playwright.config.js', {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '2',
          EXCLUSION_NATIVE: mode === 'native' ? '1' : '0',
        },
      })
      child.stdout.on('data', chunk => { output += chunk.toString() })
      child.stderr.on('data', chunk => { output += chunk.toString() })
      const eventsPromise = receiver.gatherPayloadsUntilChildExit(child,
        ({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const tests = payloads.flatMap(({ payload }) => payload.events)
            .filter(event => event.type === 'test').map(event => event.content)
          for (const [name, properties] of Object.entries(assigned)) {
            const attempts = tests.filter(test => test.meta[TEST_NAME] === name)
            const noRetry = !['ordinary control', 'protected retries', 'protected attempt to fix'].includes(name)
            const protect = name.startsWith('combined') || name.startsWith('protected')
            const count = name === 'disabled exclusion' || name === 'protected passing'
              ? 1
              : noRetry && mode !== 'native' ? 1 : 3
            assert.strictEqual(attempts.length, count, `${name}: ${output}`)
            for (const test of attempts) {
              assert.strictEqual(test.meta['test.test_management.prevent_failure_suppression'],
                protect ? 'true' : undefined, name)
              assert.strictEqual(test.meta['test.test_management.no_auto_retry'], noRetry ? 'true' : undefined, name)
              assert.strictEqual(test.meta[TEST_STATUS], name === 'disabled exclusion'
                ? 'skip'
                : name === 'protected passing' ? 'pass' : 'fail', name)
              for (const [property, tag] of [
                ['attempt_to_fix', TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX],
                ['disabled', TEST_MANAGEMENT_IS_DISABLED],
                ['quarantined', TEST_MANAGEMENT_IS_QUARANTINED],
              ]) assert.strictEqual(test.meta[tag], properties[property] ? 'true' : undefined, name)
              if (noRetry) {
                assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], undefined)
                assert.strictEqual(test.meta[TEST_RETRY_REASON],
                  mode === 'native' && test.meta[TEST_IS_RETRY] ? TEST_RETRY_REASON_TYPES.ext : undefined)
              }
            }
          }
          const skipped = tests.find(test => test.meta[TEST_NAME] === 'developer skip')
          assert.strictEqual(skipped.meta[TEST_STATUS], 'skip')
          assert.strictEqual(skipped.meta['test.test_management.no_auto_retry'], 'true')
          assert.strictEqual(skipped.meta['test.test_management.prevent_failure_suppression'], 'true')
        })
      const [[exitCode]] = await Promise.all([once(child, 'exit'), eventsPromise])
      assert.strictEqual(exitCode, 1, output)
    })
  }
})
