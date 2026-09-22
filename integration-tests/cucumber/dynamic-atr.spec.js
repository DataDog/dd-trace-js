'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { readFileSync } = require('node:fs')

const satisfies = require('semifies')

const { engines, nodeMaxMajor } = require('../../package.json')
const { isTrue } = require('../../packages/dd-trace/src/guardrails/util')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { getCiVisAgentlessConfig, sandboxCwd, useSandbox } = require('../helpers')
const {
  TEST_FINAL_STATUS,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_IS_RETRY,
  TEST_NAME,
  TEST_RETRY_REASON,
  TEST_RETRY_REASON_TYPES,
  TEST_STATUS,
} = require('../../packages/dd-trace/src/plugins/util/test')

const version = process.env.CUCUMBER_VERSION || 'latest'
const supportsTracer = satisfies(process.versions.node, `${engines.node} <${nodeMaxMajor}`) ||
  isTrue(process.env.DD_INJECT_FORCE)
const supportsRetries = version === 'latest' || satisfies(version, '>=8.0.0')
const describeRetries = supportsTracer ? describe : describe.skip
const fixture = 'ci-visibility/cucumber-dynamic-atr'
const durationBuckets = [
  [0, 0], [4999, 0], [5000, 0], [5001, 1], [10000, 1],
  [10001, 2], [30000, 2], [30001, 3], [300000, 3], [300001, 4],
]

describeRetries(`cucumber@${version} dynamic ATR`, function () {
  this.timeout(60000)
  let cwd, receiver, childProcess

  useSandbox([`@cucumber/cucumber@${version}`, 'sinon'], true)

  before(function () {
    cwd = sandboxCwd()
    const cucumber = require(`${cwd}/node_modules/@cucumber/cucumber/package.json`)
    if (!satisfies(process.versions.node, cucumber.engines.node)) {
      // Cucumber exits before running scenarios on unsupported Node.js versions.
      this.skip()
    }
  })

  beforeEach(async () => {
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

  for (const parallel of [false, true]) {
    context(parallel ? 'parallel' : 'serial', () => {
      /**
       * @param {string} feature
       * @param {Record<string, string>} [env]
       * @param {string[]} [args]
       */
      async function run (feature, env = {}, args = []) {
        childProcess = spawn('./node_modules/.bin/cucumber-js', [
          `${fixture}/${feature}.feature`,
          '--require', `${fixture}/support/steps.js`,
          ...(parallel ? ['--parallel', '2'] : []),
          ...args,
        ], {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED: 'true',
            DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: '1,2,3,4,5',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '7',
            ...env,
          },
        })
        let output = ''
        childProcess.stdout.on('data', chunk => { output += chunk })
        childProcess.stderr.on('data', chunk => { output += chunk })
        let events
        await receiver.gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          payloads => { events = payloads.flatMap(({ payload }) => payload.events) }
        )
        assert.ok(events?.some(event => event.type === 'test'), output)
        return { events, exitCode: childProcess.exitCode, output }
      }

      if (!supportsRetries) {
        for (const bucketConfig of ['custom', 'fallback']) {
          it(`preserves static retries before Cucumber 8 with ${bucketConfig} buckets`, async () => {
            receiver.setSettings({
              flaky_test_retries_enabled: true,
              early_flake_detection: { enabled: false, slow_test_retries: { '5s': 3 } },
            })
            const messagesPath = `${cwd}/attempts.ndjson`
            const { exitCode, output } = await run('budgets', {
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
              DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: bucketConfig === 'custom' ? '1,2,3,4,5' : '',
            }, ['--name', '^duration 0$', '--format', `message:${messagesPath}`])
            assert.strictEqual(exitCode, 1, output)
            // Cucumber 7 does not expose individual retry attempts as test spans.
            const messages = readFileSync(messagesPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
            assert.strictEqual(messages.filter(message => message.testCaseStarted).length, 2)
          })
        }
        return
      }

      for (const [feature, name, count, status, expectedExitCode] of [
        ['budgets', 'duration 0', 3, 'fail', 1],
        ['recovery', 'recovers', 3, 'pass', 0],
        ['recovery', 'passes', 1, 'pass', 0],
        ['recovery', 'skips', 1, 'skip', 0],
      ]) {
        it(`preserves native retry final status with a zero ATR budget for ${name}`, async () => {
          const { events, exitCode, output } = await run(feature, {
            DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED: 'false',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '0',
          }, ['--name', `^${name}$`, '--retry', '2'])
          assert.strictEqual(exitCode, expectedExitCode, output)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.strictEqual(tests.length, count)
          const terminal = tests.filter(test => test.meta[TEST_FINAL_STATUS] !== undefined)
          assert.strictEqual(terminal.length, 1)
          assert.strictEqual(terminal[0].meta[TEST_STATUS], status)
          assert.strictEqual(terminal[0].meta[TEST_FINAL_STATUS], status)
          assert.strictEqual(terminal[0].meta[TEST_HAS_FAILED_ALL_RETRIES], undefined)
        })
      }

      for (const bucketConfig of ['custom', 'backend', 'empty entry']) {
        it(`uses initial duration buckets with ${bucketConfig} budgets and EFD disabled`, async () => {
          const custom = bucketConfig === 'custom'
          const budgets = custom ? [1, 2, 3, 4, 5] : [2, 3, 4, 5, 1]
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            known_tests_enabled: false,
            early_flake_detection: {
              enabled: false,
              slow_test_retries: { '5s': 2, '10s': 3, '30s': 4, '5m': 5 },
            },
          })
          const { events, exitCode, output } = await run('budgets', {
            DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: custom
              ? budgets.join(',')
              : bucketConfig === 'empty entry' ? '1,2,,3,4,5' : '',
            DD_TEST_EARLY_FLAKE_DETECTION_RETRY_COUNT: '17',
          })
          assert.strictEqual(exitCode, 1, output)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          for (const [duration, bucket] of durationBuckets) {
            const attempts = tests.filter(test => test.meta[TEST_NAME] === `duration ${duration}`)
            assert.strictEqual(attempts.length, budgets[bucket] + 1, `duration ${duration}`)
            assert.ok(attempts.every(test => test.meta[TEST_STATUS] === 'fail'))
            const retries = attempts.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retries.length, budgets[bucket])
            assert.ok(retries.every(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr))
            const terminal = attempts.filter(test => test.meta[TEST_FINAL_STATUS] !== undefined)
            assert.strictEqual(terminal.length, 1)
            assert.strictEqual(terminal[0].meta[TEST_FINAL_STATUS], 'fail')
            assert.strictEqual(terminal[0].meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
          }
          assert.strictEqual(events.filter(event => event.type === 'test_suite_end').length, 1)
        })
      }

      it('stops after recovery and preserves passing and skipped scenarios', async () => {
        const { events, exitCode, output } = await run('recovery')
        assert.strictEqual(exitCode, 0, output)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)
        for (const [name, count, status] of [['recovers', 3, 'pass'], ['passes', 1, 'pass'], ['skips', 1, 'skip']]) {
          const attempts = tests.filter(test => test.meta[TEST_NAME] === name)
          assert.strictEqual(attempts.length, count, name)
          const terminal = attempts.find(test => test.meta[TEST_FINAL_STATUS] !== undefined)
          assert.strictEqual(terminal.meta[TEST_FINAL_STATUS], status)
          assert.strictEqual(terminal.meta[TEST_HAS_FAILED_ALL_RETRIES], undefined)
        }
        const suites = events.filter(event => event.type === 'test_suite_end')
        assert.strictEqual(suites.length, 1)
        assert.strictEqual(suites[0].content.meta[TEST_STATUS], 'pass')
      })

      it('keeps one fallback retry when every EFD bucket is zero', async () => {
        receiver.setSettings({
          flaky_test_retries_enabled: true,
          known_tests_enabled: false,
          early_flake_detection: {
            enabled: true,
            slow_test_retries: { '5s': 0, '10s': 0, '30s': 0, '5m': 0 },
          },
        })
        const { events, exitCode, output } = await run('budgets', {
          DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: '',
          DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '0',
        }, ['--name', '^duration 300001$'])
        assert.strictEqual(exitCode, 1, output)
        const tests = events.filter(event => event.type === 'test')
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(tests.at(-1).content.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')
      })

      // Managed EFD/Attempt to Fix retries are supported in parallel from Cucumber 11.
      const managedIt = parallel && version !== 'latest' && satisfies(version, '<11.0.0') ? it.skip : it
      for (const reason of ['efd', 'attempt_to_fix']) {
        managedIt(`preserves ${reason} retry precedence`, async () => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            known_tests_enabled: reason === 'efd',
            early_flake_detection: {
              enabled: reason === 'efd',
              slow_test_retries: { '5s': 3 },
              faulty_session_threshold: 100,
            },
            test_management: { enabled: reason === 'attempt_to_fix', attempt_to_fix_retries: 3 },
          })
          receiver.setKnownTests({ cucumber: {} })
          receiver.setTestManagementTests({
            cucumber: {
              suites: {
                [`${fixture}/budgets.feature`]: {
                  tests: { 'duration 0': { properties: { attempt_to_fix: true } } },
                },
              },
            },
          })
          const { events, exitCode, output } = await run('budgets', {}, ['--name', '^duration 0$'])
          assert.strictEqual(exitCode, 1, output)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.strictEqual(tests.length, 4)
          const retries = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
          assert.strictEqual(retries.length, 3)
          const retryReason = reason === 'efd' ? TEST_RETRY_REASON_TYPES.efd : TEST_RETRY_REASON_TYPES.atf
          assert.ok(retries.every(test => test.meta[TEST_RETRY_REASON] === retryReason))
        })
      }

      it('respects the native retry tag filter', async () => {
        const { events, exitCode, output } = await run('budgets', {}, [
          '--name', '^duration 0$', '--retry', '7', '--retry-tag-filter', '@retryable',
        ])
        assert.strictEqual(exitCode, 1, output)
        const tests = events.filter(event => event.type === 'test')
        assert.strictEqual(tests.length, 1)
        assert.strictEqual(tests[0].content.meta[TEST_FINAL_STATUS], 'fail')
      })

      for (const [name, env, settings, count] of [
        ['dynamic ATR is disabled', { DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED: 'false' }, {}, 8],
        ['backend ATR is disabled', {}, { flaky_test_retries_enabled: false }, 1],
        ['local ATR is disabled', { DD_CIVISIBILITY_FLAKY_RETRY_ENABLED: 'false' }, {}, 1],
      ]) {
        it(`preserves existing behavior when ${name}`, async () => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            early_flake_detection: { enabled: false },
            ...settings,
          })
          const { events, exitCode, output } = await run('budgets', env, ['--name', '^duration 0$'])
          assert.strictEqual(exitCode, 1, output)
          const tests = events.filter(event => event.type === 'test')
          assert.strictEqual(tests.length, count)
        })
      }
    })
  }
})
