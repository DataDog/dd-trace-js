'use strict'

const { fork, exec } = require('child_process')
const fs = require('fs')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const path = require('path')
const { inspect } = require('node:util')

const satisfies = require('semifies')

const { assertObjectContains } = require('../helpers')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  finishDeferredHookEnd,
  wrapFailedTestReplayHookUpCallback,
} = require('../../packages/datadog-instrumentations/src/mocha/utils')
const {
  TEST_CODE_COVERAGE_ENABLED,
  TEST_ITR_SKIPPING_ENABLED,
  TEST_ITR_TESTS_SKIPPED,
  TEST_CODE_COVERAGE_LINES_PCT,
  TEST_SUITE,
  TEST_STATUS,
  TEST_TYPE,
  TEST_FRAMEWORK,
  TEST_SKIPPED_BY_ITR,
  TEST_ITR_SKIPPING_TYPE,
  TEST_ITR_SKIPPING_COUNT,
  TEST_ITR_UNSKIPPABLE,
  TEST_ITR_FORCED_RUN,
  TEST_SOURCE_FILE,
  TEST_IS_RETRY,
  TEST_NAME,
  TEST_COMMAND,
  TEST_MODULE,
  MOCHA_IS_PARALLEL,
  TEST_SOURCE_START,
  TEST_CODE_OWNERS,
  TEST_SESSION_NAME,
  TEST_RETRY_REASON,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_RETRY_REASON_TYPES,
  CI_APP_ORIGIN,
  TEST_FRAMEWORK_VERSION,
  LIBRARY_VERSION,
  TEST_PARAMETERS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS,
  TEST_FINAL_STATUS,
  TEST_IMPACT_ANALYSIS_ALL_TESTS_SKIPPED_MESSAGE,
  TEST_SESSION_EMPTY_REASON,
  TEST_SKIP_REASON,
  getLineCoverageBitmap,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')
const {
  ERROR_MESSAGE,
  ORIGIN_KEY,
  COMPONENT,
  ERROR_STACK,
  ERROR_TYPE,
} = require('../../packages/dd-trace/src/constants')
const { DD_MAJOR, VERSION: ddTraceVersion } = require('../../version')
const { getLatestMochaSpecifier } = require('./versions')

function assertItrSkippingEnabledTags (events, expected) {
  const testSuite = events.find(event => event.type === 'test_suite_end').content
  assert.strictEqual(testSuite.meta[TEST_ITR_SKIPPING_ENABLED], expected)
  const test = events.find(event => event.type === 'test').content
  assert.strictEqual(test.meta[TEST_ITR_SKIPPING_ENABLED], expected)
}

function getLinesBitmapBase64 (startLine, endLine) {
  const lineCoverage = {}
  for (let line = startLine; line <= endLine; line++) {
    lineCoverage[line] = 1
  }
  return getLineCoverageBitmap(lineCoverage, true).toString('base64')
}

const runTestsCommand = 'node ./ci-visibility/run-mocha.js'
const runTestsWithCoverageCommand = `./node_modules/nyc/bin/nyc.js -r=text-summary ${runTestsCommand}`
const testFile = 'ci-visibility/run-mocha.js'
const expectedStdout = '2 passing'
const extraStdout = 'end event: can add event listeners to mocha'

const requestedMochaVersion = process.env.MOCHA_VERSION || 'latest'
const oldestMochaVersion = DD_MAJOR >= 6 ? '8.0.0' : '5.2.0'
const MOCHA_VERSION = requestedMochaVersion === 'oldest' ? oldestMochaVersion : requestedMochaVersion
const mochaDependencyVersion = MOCHA_VERSION === 'latest' ? getLatestMochaSpecifier() : MOCHA_VERSION
const mochaMajor = MOCHA_VERSION === 'latest' ? Infinity : Number.parseInt(MOCHA_VERSION, 10)
const supportsMochaRetryEvents = mochaMajor >= 6
// ATR needs the retry event introduced in Mocha 6.
const retryEventsIt = supportsMochaRetryEvents ? it : it.skip
// Dynamic ATR requires Mocha 8; older versions retain fixed-count ATR.
// Global setup/teardown fixtures were introduced in Mocha 8.2.0.
const globalFixturesIt = MOCHA_VERSION === 'latest' || satisfies(MOCHA_VERSION, '>=8.2.0') ? it : it.skip
const onlyLatestIt = MOCHA_VERSION === 'latest' ? it : it.skip
// Mocha 8.0 through 8.2 use workerpool 6.0.x, which cannot start process workers on supported Node versions.
const parallelIt = MOCHA_VERSION === 'latest' || satisfies(MOCHA_VERSION, '>=8.3.0') ? it : it.skip
// TODO: Remove this temporary release unblock once the Mocha 5.2 regressions introduced by #9798 are fixed.
const reporterFinalizationIt = DD_MAJOR === 5 && MOCHA_VERSION === '5.2.0' ? it.skip : it

describe('mocha failed test replay helpers', () => {
  describe('finishDeferredHookEnd', () => {
    it('finishes synchronously when there is no DI wait promise', () => {
      let finishCount = 0
      let onFinishCount = 0
      const test = {
        _ddDeferredHookEnd: {
          publishTestFinish () {
            finishCount++
          },
          onFinish () {
            onFinishCount++
          },
        },
      }

      finishDeferredHookEnd(test)

      assert.strictEqual(finishCount, 1)
      assert.strictEqual(onFinishCount, 1)
      assert.strictEqual(test._ddDeferredHookEnd, undefined)
    })
  })

  describe('wrapFailedTestReplayHookUpCallback', () => {
    it('waits for DI setup before continuing afterEach hookUp', async () => {
      let resolveSetProbe
      const setProbePromise = new Promise(resolve => {
        resolveSetProbe = resolve
      })
      const err = new Error('test')
      const suite = {}
      let receivedArgs
      function next (err, suite) {
        receivedArgs = [err, suite]
      }
      const wrapped = wrapFailedTestReplayHookUpCallback(next, {}, setProbePromise)

      assert.strictEqual(wrapped.name, 'next')
      assert.strictEqual(wrapped.length, 2)
      wrapped(err, suite)

      assert.strictEqual(receivedArgs, undefined)

      resolveSetProbe()
      await setProbePromise
      await Promise.resolve()

      assert.deepStrictEqual(receivedArgs, [err, suite])
    })

    it('runs deferred hook-end finish before continuing afterEach hookUp', async () => {
      const calls = []
      const test = {
        _ddDeferredHookEnd: {
          waitForHitProbePromise: Promise.resolve(),
          publishTestFinish () {
            calls.push('finish')
          },
        },
      }
      function next () {
        calls.push('next')
      }

      const wrapped = wrapFailedTestReplayHookUpCallback(next, test)

      assert.strictEqual(wrapped.length, 0)
      await wrapped()

      assert.deepStrictEqual(calls, ['finish', 'next'])
    })
  })
})

describe(`mocha@${MOCHA_VERSION}`, function () {
  let receiver
  let childProcess
  let cwd
  let startupTestFile
  let testOutput = ''

  useSandbox(
    [
      `mocha@${mochaDependencyVersion}`,
      'nyc',
      'mocha-each',
      'workerpool',
      'sinon',
    ],
    true
  )

  before(function () {
    cwd = sandboxCwd()
    startupTestFile = path.join(cwd, testFile)
  })

  beforeEach(async function () {
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(async () => {
    childProcess.kill()
    testOutput = ''
    await receiver.stop()
  })

  for (const scenario of [
    {
      name: 'native retries',
      file: 'mocha-hooks/retries-with-hooks.js',
      run: retryEventsIt,
      exitCode: 1,
      expected: {
        'mocha-test-retries-with-hooks will be retried and pass': ['fail', 'fail', 'pass'],
        'mocha-test-retries-with-hooks will be retried and fail': ['fail', 'fail', 'fail', 'fail', 'fail'],
      },
    },
    {
      name: 'beforeEach and afterEach failures',
      file: 'mocha-plugin-tests/hook-async-error.js',
      run: it,
      exitCode: 5,
      expected: {
        'mocha-fail-hook-async will run but be reported as failed': ['fail'],
        'mocha-fail-hook-async-other will run and be reported as passed': ['pass'],
        'mocha-fail-hook-async-other-before will not run and be reported as failed': ['fail'],
        'mocha-fail-hook-async-other-second-after will run and be reported as failed': ['fail'],
        'mocha-fail-test-after-each-passes will fail and be reported as failed': ['fail'],
      },
    },
  ]) {
    scenario.run(`finishes ${scenario.name} when failure videos are enabled outside WebdriverIO`, async () => {
      receiver.setSettings({ itr_enabled: false, flaky_test_retries_enabled: false, di_enabled: false })
      childProcess = exec(`node node_modules/mocha/bin/mocha ci-visibility/${scenario.file}`, {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          DD_INJECT_FORCE: 'true',
          DD_TEST_FAILURE_VIDEOS_ENABLED: 'true',
          DD_CIVISIBILITY_FLAKY_RETRY_ENABLED: 'false',
          DD_TEST_FAILED_TEST_REPLAY_ENABLED: 'false',
        },
      })
      childProcess.stdout.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr.on('data', chunk => { testOutput += chunk.toString() })
      const eventsPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.strictEqual(tests.length, Object.values(scenario.expected).flat().length, testOutput)
          assert.strictEqual(new Set(tests.map(test => test.span_id.toString())).size, tests.length)
          for (const [name, statuses] of Object.entries(scenario.expected)) {
            const attempts = tests.filter(test => test.meta[TEST_NAME] === name)
            assert.deepStrictEqual(attempts.map(test => test.meta[TEST_STATUS]), statuses, name)
            for (const [index, attempt] of attempts.entries()) {
              if (statuses[index] === 'fail') assert.ok(attempt.meta[ERROR_STACK], name)
              if (index > 0) {
                assert.strictEqual(attempt.meta[TEST_IS_RETRY], 'true')
                assert.strictEqual(attempt.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.ext)
              }
            }
          }
          for (const type of ['test_suite_end', 'test_module_end', 'test_session_end']) {
            const matching = events.filter(event => event.type === type)
            assert.strictEqual(matching.length, 1, type)
            assert.strictEqual(matching[0].content.meta[TEST_STATUS], 'fail', type)
          }
        }
      )
      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
      assert.strictEqual(exitCode, scenario.exitCode, testOutput)
    })
  }

  for (const status of ['pass', 'fail']) {
    it(`reports a ${status}ing test with a mocked global URL and disabled DogStatsD`, async () => {
      receiver.setSettings({ itr_enabled: false })
      childProcess = exec('node node_modules/mocha/bin/mocha ci-visibility/mocha-plugin-tests/mocked-url.js', {
        cwd,
        env: {
          ...getCiVisEvpProxyConfig(receiver.port),
          DD_INJECT_FORCE: 'true',
          DD_TRACE_AGENT_URL: `http://127.0.0.1:${receiver.port}`,
          DD_RUNTIME_METRICS_ENABLED: 'false',
          MOCKED_URL_TEST_FAIL: status === 'fail' ? '1' : '0',
        },
      })
      childProcess.stdout.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr.on('data', chunk => { testOutput += chunk.toString() })

      const eventsPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle') || url === '/dogstatsd/v2/proxy',
        payloads => {
          const metrics = payloads.filter(({ url }) => url === '/dogstatsd/v2/proxy')
          assert.strictEqual(metrics.length, 0, `unexpected DogStatsD telemetry: ${testOutput}`)

          const events = payloads.filter(({ url }) => url.endsWith('/api/v2/citestcycle'))
            .flatMap(({ payload }) => payload.events)
          for (const type of ['test', 'test_suite_end', 'test_module_end', 'test_session_end']) {
            const matching = events.filter(event => event.type === type)
            assert.strictEqual(matching.length, 1, `expected one ${type}: ${testOutput}`)
            assert.strictEqual(matching[0].content.meta[TEST_STATUS], status, testOutput)
          }
          const test = events.find(event => event.type === 'test').content
          if (status === 'fail') {
            assert.strictEqual(test.meta[ERROR_TYPE], 'Error')
            assert.strictEqual(test.meta[ERROR_MESSAGE], 'expected test failure')
          } else {
            assert.strictEqual(test.error, 0)
          }
        }
      )
      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
      assert.strictEqual(exitCode, status === 'fail' ? 1 : 0, testOutput)
      assert.doesNotMatch(testOutput, /URL is not a constructor/)
    })
  }

  for (const { mode, args, reason, exitCode: expectedExitCode } of [
    { mode: 'skip-tests', args: '', reason: 'all_tests_skipped', exitCode: 0 },
    { mode: 'skip-suite', args: '', reason: 'all_tests_skipped', exitCode: 0 },
    { mode: 'mixed', args: '', reason: undefined, exitCode: 0 },
    { mode: 'empty', args: '', reason: 'zero_tests', exitCode: 0 },
    { mode: 'mixed', args: '--grep never-matches', reason: 'zero_tests', exitCode: 0 },
    { mode: 'error', args: '', reason: undefined, exitCode: 1 },
    { mode: 'empty', args: '--fail-zero', reason: undefined, exitCode: 1 },
  ]) {
    // --fail-zero was introduced in Mocha 9.1.0.
    const emptySessionIt = args === '--fail-zero' &&
      MOCHA_VERSION !== 'latest' && !satisfies(MOCHA_VERSION, '>=9.1.0')
      ? it.skip
      : it
    emptySessionIt(`reports zero-execution sessions: ${mode} ${args}`, async () => {
      receiver.setSettings({ itr_enabled: false, tests_skipping: false, code_coverage: false })
      childProcess = exec('node node_modules/mocha/bin/mocha ci-visibility/empty-session-tests.js ' + args, {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          EMPTY_SESSION_MODE: mode,
        },
      })
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })
      const eventsPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          for (const type of ['test_session_end', 'test_module_end']) {
            const event = events.find(event => event.type === type)?.content
            assert.ok(event, testOutput)
            const expectedStatus = expectedExitCode ? 'fail' : reason ? 'skip' : 'pass'
            assert.strictEqual(event.meta[TEST_STATUS], expectedStatus, testOutput)
            assert.strictEqual(event.meta[TEST_SESSION_EMPTY_REASON], reason, testOutput)
            assert.strictEqual(event.meta[TEST_SKIP_REASON], reason === 'all_tests_skipped'
              ? 'All tests were skipped'
              : reason === 'zero_tests' ? 'No tests were detected' : undefined)
          }
        }
      )
      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
      assert.strictEqual(exitCode, expectedExitCode, testOutput)
    })
  }

  context('async global setup', () => {
    for (const entrypoint of ['cli', 'programmatic']) {
      for (const order of ['configuration-first', 'setup-first']) {
        for (const settingsError of [false, true]) {
          globalFixturesIt(`runs ${entrypoint}, ${order}, settingsError=${settingsError}`, async () => {
            receiver.setSettings({ itr_enabled: false })
            if (settingsError) receiver.setSettingsResponseCode(404)

            const setup = './ci-visibility/mocha-global-setup.js'
            const suite = 'ci-visibility/mocha-global-setup-test.js'
            const command = entrypoint === 'cli'
              ? `node node_modules/mocha/bin/mocha --no-config --no-package --require ${setup} ./${suite}`
              : `node ${setup}`
            childProcess = exec(command, {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                DD_INJECT_FORCE: 'true',
                DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: 'false',
                MOCHA_SETUP_ORDER: order,
                MOCHA_SETUP_ERROR: 'false',
                MOCHA_DISABLE_PLUGIN: 'false',
              },
            })
            childProcess.stdout.on('data', chunk => { testOutput += chunk.toString() })
            childProcess.stderr.on('data', chunk => { testOutput += chunk.toString() })

            const eventsPromise = receiver.gatherPayloadsUntilChildExit(
              childProcess,
              ({ url }) => url.endsWith('/api/v2/citestcycle'),
              payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                for (const type of ['test', 'test_suite_end', 'test_module_end', 'test_session_end']) {
                  const matching = events.filter(event => event.type === type)
                  assert.strictEqual(matching.length, 1, `expected one ${type}`)
                  assert.strictEqual(matching[0].content.meta[TEST_STATUS], 'pass')
                  if (settingsError) {
                    assert.strictEqual(matching[0].content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
                  }
                }
                const test = events.find(event => event.type === 'test').content
                assertObjectContains(test.meta, {
                  [TEST_NAME]: 'global setup runs after setup',
                  [TEST_SUITE]: suite,
                  [TEST_FRAMEWORK]: 'mocha',
                })
              }
            )

            const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
            assert.strictEqual(exitCode, 0, testOutput)
            assert.match(testOutput, /GLOBAL SETUP FINISHED/)
            assert.match(testOutput, /1 passing/)
            assert.match(testOutput, /GLOBAL TEARDOWN FINISHED/)
          })

          globalFixturesIt(`runs after disabling the plugin: ${entrypoint}, ${order}, settingsError=${settingsError}`,
            async () => {
              receiver.setSettings({ itr_enabled: false })
              if (settingsError) receiver.setSettingsResponseCode(404)
              const events = []
              let settingsRequests = 0
              receiver.on('message', ({ url, payload }) => {
                if (url.endsWith('/api/v2/citestcycle')) events.push(...payload.events)
                if (url.endsWith('/libraries/tests/services/setting')) settingsRequests++
              })

              const setup = './ci-visibility/mocha-global-setup.js'
              const suite = './ci-visibility/mocha-global-setup-test.js'
              const command = entrypoint === 'cli'
                ? `node node_modules/mocha/bin/mocha --no-config --no-package --require ${setup} ${suite}`
                : `node ${setup}`
              childProcess = exec(command, {
                cwd,
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  DD_INJECT_FORCE: 'true',
                  DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: 'false',
                  MOCHA_SETUP_ORDER: order,
                  MOCHA_SETUP_ERROR: 'false',
                  MOCHA_DISABLE_PLUGIN: 'true',
                },
              })
              childProcess.stdout.on('data', chunk => { testOutput += chunk.toString() })
              childProcess.stderr.on('data', chunk => { testOutput += chunk.toString() })

              const [exitCode] = await once(childProcess, 'close')
              assert.strictEqual(exitCode, 0, testOutput)
              assert.strictEqual(settingsRequests, 1)
              assert.match(testOutput, /GLOBAL SETUP FINISHED/)
              assert.match(testOutput, /1 passing/)
              assert.match(testOutput, /GLOBAL TEARDOWN FINISHED/)
              assert.deepStrictEqual(events, [], 'disabled plugin must not report test events')
            })
        }
      }
    }
  })

  const reporterEvents = [
    'end', 'start', 'fail', 'pass', 'pending', 'suite', 'test', 'test end', 'hook', 'hook end', 'suite end',
  ]
  if (supportsMochaRetryEvents) reporterEvents.push('retry')
  for (const reporterEvent of reporterEvents) {
    it(`finalizes a failed hierarchy when a custom reporter throws during runner ${reporterEvent}`, async function () {
      this.timeout(20_000)
      let reporterTestFile = './ci-visibility/mocha-plugin-tests/passing.js'
      if (reporterEvent === 'fail') {
        reporterTestFile = './ci-visibility/mocha-plugin-tests/failing.js'
      } else if (reporterEvent === 'hook end') {
        reporterTestFile = './ci-visibility/mocha-plugin-tests/passing-with-after-each.js'
      } else if (reporterEvent === 'pending') {
        reporterTestFile = './ci-visibility/mocha-plugin-tests/skipping-with-after-each.js'
      } else if (reporterEvent === 'retry') {
        reporterTestFile = './ci-visibility/mocha-plugin-tests/retries.js'
      } else if (reporterEvent === 'pass' || reporterEvent === 'test end') {
        reporterTestFile = './ci-visibility/mocha-plugin-tests/reporter-terminal-event.js'
      } else if (reporterEvent === 'start') {
        reporterTestFile = './ci-visibility/mocha-plugin-tests/reporter-run-start.js'
      } else if (reporterEvent === 'suite') {
        reporterTestFile = './ci-visibility/mocha-plugin-tests/reporter-suite-start.js'
      } else if (reporterEvent === 'test' || reporterEvent === 'hook') {
        reporterTestFile = './ci-visibility/mocha-plugin-tests/reporter-test-start.js'
      }
      childProcess = exec(
        [
          'node node_modules/mocha/bin/mocha',
          reporterTestFile,
          '--reporter ./ci-visibility/mocha-reporter-throws.js',
        ].join(' '),
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            MOCHA_REPORTER_THROW_EVENT: reporterEvent,
            ...(['test', 'hook'].includes(reporterEvent) && { MOCHA_REPORT_PENDING_AT_END: '1' }),
          },
        }
      )
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

      const eventsPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const hierarchyEventTypes = ['test_session_end', 'test_module_end']
          if (reporterEvent !== 'start') hierarchyEventTypes.push('test_suite_end')
          for (const eventType of hierarchyEventTypes) {
            const event = events.find(event => event.type === eventType)
            assert.ok(event, `expected ${eventType} event`)
            assert.strictEqual(event.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(event.content.error, 1)
            assert.match(event.content.meta[ERROR_MESSAGE], /custom Mocha reporter failed/)
          }
          if (reporterEvent === 'fail') {
            const testEvent = events.find(event =>
              event.type === 'test' && event.content.meta[TEST_NAME] === 'mocha-test-fail can fail'
            )
            assert.ok(testEvent, 'expected failed test event')
            assert.strictEqual(testEvent.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testEvent.content.error, 1)
            assert.match(testEvent.content.meta[ERROR_MESSAGE], /Expected values to be strictly equal/)
            assert.doesNotMatch(testEvent.content.meta[ERROR_MESSAGE], /custom Mocha reporter failed/)
          }
          if (reporterEvent === 'test end' || reporterEvent === 'hook end' || reporterEvent === 'pending') {
            let expectedTestName = 'mocha-test-pass-two can pass'
            if (reporterEvent === 'hook end') expectedTestName = 'mocha-reporter-hook-end can pass'
            else if (reporterEvent === 'pending') expectedTestName = 'mocha-reporter-pending-after-each can skip'
            const testEvents = events.filter(event =>
              event.type === 'test' && event.content.meta[TEST_NAME] === expectedTestName
            )
            assert.strictEqual(testEvents.length, 1, 'expected one completed test event')
            const [testEvent] = testEvents
            assert.ok(testEvent, 'expected completed test event')
            assert.strictEqual(testEvent.content.meta[TEST_STATUS], reporterEvent === 'pending' ? 'skip' : 'pass')
            assert.strictEqual(testEvent.content.error, 0)
            assert.strictEqual(
              testEvent.content.meta[TEST_SUITE],
              reporterTestFile.slice(2)
            )
            assert.strictEqual(testEvent.content.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(testEvent.content.meta[TEST_TYPE], 'test')
          }
          if (reporterEvent === 'retry') {
            const testEvent = events.find(event =>
              event.type === 'test' && event.content.meta[TEST_NAME] === 'mocha-test-retries will be retried and pass'
            )
            assert.ok(testEvent, 'expected retried test event')
            assert.strictEqual(testEvent.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testEvent.content.error, 1)
            assert.match(testEvent.content.meta[ERROR_MESSAGE], /Expected values to be strictly equal/)
            assert.doesNotMatch(testEvent.content.meta[ERROR_MESSAGE], /custom Mocha reporter failed/)
          }
          if (reporterEvent === 'test') {
            const testEvent = events.find(event => event.type === 'test')
            assert.ok(testEvent, 'expected aborted test event')
            assert.strictEqual(testEvent.content.meta[TEST_STATUS], 'skip')
          }
          if (reporterEvent === 'hook') {
            const testEvent = events.find(event => event.type === 'test')
            assert.ok(testEvent, 'expected aborted test event')
            assert.strictEqual(testEvent.content.meta[TEST_STATUS], 'skip')
            assert.strictEqual(testEvent.content.error, 0)
          }
        },
        { hardTimeout: 20_000 }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        eventsPromise,
      ])
      // Mocha 5's uncaught-exception listener preserves the exit code but does not print the delayed error.
      if (mochaMajor >= 8) assert.match(testOutput, /custom Mocha reporter failed/)
      if (reporterEvent === 'start' || reporterEvent === 'suite' || reporterEvent === 'test' ||
        reporterEvent === 'hook') {
        assert.doesNotMatch(testOutput, /MOCHA (?:BEFORE|AFTER|TEST)/)
      }
      if (reporterEvent === 'test' || reporterEvent === 'hook') {
        assert.match(testOutput, /REPORTER TEST PENDING AT END: true/)
      }
      if (['pass', 'fail', 'pending', 'retry', 'test end'].includes(reporterEvent)) {
        assert.doesNotMatch(testOutput, /MOCHA AFTER EACH EXECUTED/)
      }
      assert.notStrictEqual(exitCode, 0, testOutput)
    })
  }

  it('finalizes a failed session when a custom reporter throws undefined', async function () {
    this.timeout(20_000)
    childProcess = exec(
      'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/passing.js ' +
      '--reporter ./ci-visibility/mocha-reporter-throws.js',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          MOCHA_REPORTER_THROW_EVENT: 'end',
          MOCHA_REPORTER_THROWS_UNDEFINED: '1',
        },
      }
    )

    const eventsPromise = receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url.endsWith('/api/v2/citestcycle'),
      (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        for (const eventType of ['test_session_end', 'test_module_end', 'test_suite_end']) {
          const event = events.find(event => event.type === eventType)
          assert.ok(event, `expected ${eventType} event`)
          assert.strictEqual(event.content.meta[TEST_STATUS], 'fail')
        }
      },
      { hardTimeout: 20_000 }
    )

    const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
    assert.notStrictEqual(exitCode, 0)
  })

  it('finalizes a failed session when a reporter throws a non-coercible value', async function () {
    this.timeout(20_000)
    childProcess = exec(
      'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/passing.js ' +
      '--reporter ./ci-visibility/mocha-reporter-throws.js',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          MOCHA_REPORTER_THROW_EVENT: 'end',
          MOCHA_REPORTER_THROWS_UNCOERCIBLE: '1',
        },
      }
    )

    const eventsPromise = receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url.endsWith('/api/v2/citestcycle'),
      (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        for (const eventType of ['test_session_end', 'test_module_end', 'test_suite_end']) {
          const event = events.find(event => event.type === eventType)
          assert.ok(event, `expected ${eventType} event`)
          assert.strictEqual(event.content.meta[TEST_STATUS], 'fail')
          assert.strictEqual(event.content.meta[ERROR_MESSAGE], 'Mocha reporter failed')
        }
      },
      { hardTimeout: 20_000 }
    )

    const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
    assert.notStrictEqual(exitCode, 0)
  })

  it('finalizes a failed session when a reporter Error has a throwing message getter', async function () {
    this.timeout(20_000)
    childProcess = exec(
      'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/passing.js ' +
      '--reporter ./ci-visibility/mocha-reporter-throws.js',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          MOCHA_REPORTER_THROW_EVENT: 'end',
          MOCHA_REPORTER_THROWS_HOSTILE_ERROR: '1',
        },
      }
    )

    const eventsPromise = receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url.endsWith('/api/v2/citestcycle'),
      (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        for (const eventType of ['test_session_end', 'test_module_end', 'test_suite_end']) {
          const event = events.find(event => event.type === eventType)
          assert.ok(event, `expected ${eventType} event`)
          assert.strictEqual(event.content.meta[TEST_STATUS], 'fail')
          assert.strictEqual(event.content.meta[ERROR_MESSAGE], 'Mocha reporter failed')
        }
      },
      { hardTimeout: 20_000 }
    )

    const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
    assert.notStrictEqual(exitCode, 0)
  })

  for (const reporterThrows of [false, true]) {
    it(`keeps suite coverage visible to a ${reporterThrows ? 'failing' : 'successful'} reporter`, async function () {
      this.timeout(20_000)
      childProcess = exec(
        'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/reporter-coverage.js ' +
        '--reporter ./ci-visibility/mocha-coverage-reporter.js',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            ...(reporterThrows && { MOCHA_COVERAGE_REPORTER_THROWS: '1' }),
          },
        }
      )
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

      const eventsPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const sessionEvent = events.find(event => event.type === 'test_session_end')
          assert.ok(sessionEvent, 'expected test_session_end event')
          assert.strictEqual(sessionEvent.content.meta[TEST_STATUS], reporterThrows ? 'fail' : 'pass')
        },
        { hardTimeout: 20_000 }
      )

      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
      assert.strictEqual(exitCode === 0, !reporterThrows, testOutput)
      assert.match(testOutput, /MOCHA REPORTER COVERAGE: 1/)
    })
  }

  it('stops the test body when a custom reporter throws after beforeEach', async function () {
    this.timeout(20_000)
    childProcess = exec(
      'node node_modules/mocha/bin/mocha' +
      ' ./ci-visibility/mocha-plugin-tests/reporter-hook-end-before-each.js' +
      ' --reporter ./ci-visibility/mocha-reporter-throws.js',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          MOCHA_REPORTER_THROW_EVENT: 'hook end',
          MOCHA_REPORT_PENDING_AT_END: '1',
        },
      }
    )
    childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
    childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

    const eventsPromise = receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url.endsWith('/api/v2/citestcycle'),
      (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        for (const eventType of ['test_session_end', 'test_module_end', 'test_suite_end']) {
          const event = events.find(event => event.type === eventType)
          assert.ok(event, `expected ${eventType} event`)
          assert.strictEqual(event.content.meta[TEST_STATUS], 'fail')
          assert.strictEqual(event.content.error, 1)
          assert.match(event.content.meta[ERROR_MESSAGE], /custom Mocha reporter failed/)
        }
        const testEvent = events.find(event => event.type === 'test')
        assert.ok(testEvent, 'expected aborted test event')
        assert.strictEqual(testEvent.content.meta[TEST_STATUS], 'skip')
      },
      { hardTimeout: 20_000 }
    )

    const [[exitCode]] = await Promise.all([
      once(childProcess, 'exit'),
      eventsPromise,
    ])
    if (mochaMajor >= 8) assert.match(testOutput, /custom Mocha reporter failed/)
    assert.match(testOutput, /MOCHA BEFORE EACH EXECUTED/)
    assert.match(testOutput, /REPORTER TEST PENDING AT END: true/)
    assert.doesNotMatch(testOutput, /MOCHA (?:AFTER EACH|TEST BODY) EXECUTED/)
    assert.notStrictEqual(exitCode, 0, testOutput)
  })

  it('reports a completed test when a reporter throws on an inner afterEach hook', async function () {
    this.timeout(20_000)
    childProcess = exec(
      'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/passing-with-after-each.js ' +
      '--reporter ./ci-visibility/mocha-reporter-throws.js',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          MOCHA_REPORTER_THROW_EVENT: 'hook end',
          MOCHA_REPORTER_THROW_INNER_HOOK: '1',
        },
      }
    )

    const eventsPromise = receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url.endsWith('/api/v2/citestcycle'),
      (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testEvents = events.filter(event =>
          event.type === 'test' && event.content.meta[TEST_NAME] ===
          'mocha-reporter-hook-end-outer mocha-reporter-hook-end-inner can pass after an inner hook reporter error'
        )
        assert.strictEqual(testEvents.length, 1, 'expected one completed test event')
        const [testEvent] = testEvents
        assert.ok(testEvent, 'expected completed test event')
        assert.strictEqual(testEvent.content.meta[TEST_STATUS], 'pass')
        assert.strictEqual(testEvent.content.error, 0)
        for (const eventType of ['test_session_end', 'test_module_end', 'test_suite_end']) {
          const event = events.find(event => event.type === eventType)
          assert.ok(event, `expected ${eventType} event`)
          assert.strictEqual(event.content.meta[TEST_STATUS], 'fail')
          assert.match(event.content.meta[ERROR_MESSAGE], /custom Mocha reporter failed/)
        }
      },
      { hardTimeout: 20_000 }
    )

    const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
    assert.notStrictEqual(exitCode, 0)
  })

  for (const { file, name, status } of [
    {
      file: 'reporter-terminal-event.js',
      name: 'mocha-test-pass-two can pass',
      status: 'pass',
    },
    {
      file: 'failing.js',
      name: 'mocha-test-fail can fail',
      status: 'fail',
    },
  ]) {
    it(`preserves a completed ${status} test when a reporter throws on its afterEach hook`, async function () {
      this.timeout(20_000)
      childProcess = exec(
        `node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/${file} ` +
        '--reporter ./ci-visibility/mocha-reporter-throws.js',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            MOCHA_REPORTER_THROW_EVENT: 'hook',
            MOCHA_REPORTER_THROW_AFTER_EACH: '1',
          },
        }
      )
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

      const eventsPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testEvents = events.filter(event =>
            event.type === 'test' && event.content.meta[TEST_NAME] === name
          )
          assert.strictEqual(testEvents.length, 1, 'expected one completed test event')
          const [testEvent] = testEvents
          assert.strictEqual(testEvent.content.meta[TEST_STATUS], status)
          if (status === 'fail') {
            assert.strictEqual(testEvent.content.error, 1)
            assert.match(testEvent.content.meta[ERROR_MESSAGE], /Expected values to be strictly equal/)
            assert.doesNotMatch(testEvent.content.meta[ERROR_MESSAGE], /custom Mocha reporter failed/)
          } else {
            assert.strictEqual(testEvent.content.error, 0)
          }
          for (const eventType of ['test_session_end', 'test_module_end', 'test_suite_end']) {
            const event = events.find(event => event.type === eventType)
            assert.ok(event, `expected ${eventType} event`)
            assert.strictEqual(event.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(event.content.error, 1)
            assert.match(event.content.meta[ERROR_MESSAGE], /custom Mocha reporter failed/)
          }
        },
        { hardTimeout: 20_000 }
      )

      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
      if (mochaMajor >= 8) assert.match(testOutput, /custom Mocha reporter failed/)
      assert.doesNotMatch(testOutput, /MOCHA AFTER EACH EXECUTED/)
      assert.notStrictEqual(exitCode, 0, testOutput)
    })
  }

  reporterFinalizationIt('preserves a completed test when a reporter throws on its afterAll hook', async function () {
    this.timeout(20_000)
    const testName = 'mocha-test-pass-two can pass'
    childProcess = exec(
      'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/reporter-terminal-event.js ' +
      '--reporter ./ci-visibility/mocha-reporter-throws.js',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          MOCHA_REPORTER_THROW_EVENT: 'hook',
          MOCHA_REPORTER_THROW_AFTER_ALL: '1',
          MOCHA_REPORT_PENDING_AT_END: '1',
        },
      }
    )
    childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
    childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

    const eventsPromise = receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url.endsWith('/api/v2/citestcycle'),
      (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testEvents = events.filter(event =>
          event.type === 'test' && event.content.meta[TEST_NAME] === testName
        )
        assert.strictEqual(testEvents.length, 1)
        assert.strictEqual(testEvents[0].content.meta[TEST_STATUS], 'pass')
        assert.strictEqual(testEvents[0].content.error, 0)
        for (const eventType of ['test_session_end', 'test_module_end', 'test_suite_end']) {
          const event = events.find(event => event.type === eventType)
          assert.ok(event, `expected ${eventType} event`)
          assert.strictEqual(event.content.meta[TEST_STATUS], 'fail')
          assert.match(event.content.meta[ERROR_MESSAGE], /custom Mocha reporter failed/)
        }
      },
      { hardTimeout: 20_000 }
    )

    const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
    assert.match(testOutput, /REPORTER TEST PENDING AT END: false/)
    assert.doesNotMatch(testOutput, /MOCHA AFTER ALL EXECUTED/)
    assert.notStrictEqual(exitCode, 0, testOutput)
  })

  onlyLatestIt('marks parallel worker suites as failed when the coordinator reporter throws', async function () {
    this.timeout(20_000)
    childProcess = exec(
      'node node_modules/mocha/bin/mocha --parallel --jobs 2' +
      ' ./ci-visibility/mocha-plugin-tests/passing.js' +
      ' ./ci-visibility/test/ci-visibility-test-2.js' +
      ' --reporter ./ci-visibility/mocha-reporter-throws.js',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          MOCHA_REPORTER_THROW_EVENT: 'suite end',
          MOCHA_REPORT_RUNNER_EMIT_OWNER: '1',
        },
      }
    )
    childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
    childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

    const eventsPromise = receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url.endsWith('/api/v2/citestcycle'),
      (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const hierarchyEvents = events.filter(event =>
          event.type === 'test_session_end' ||
          event.type === 'test_module_end' ||
          event.type === 'test_suite_end'
        )
        const sessionEvent = hierarchyEvents.find(event => event.type === 'test_session_end')
        const suiteEvents = hierarchyEvents.filter(event => event.type === 'test_suite_end')

        assert.ok(sessionEvent, 'expected test_session_end event')
        assert.strictEqual(sessionEvent.content.meta[MOCHA_IS_PARALLEL], 'true')
        assert.strictEqual(suiteEvents.length, 2)
        assert.strictEqual(hierarchyEvents.length, 4)
        for (const event of hierarchyEvents) {
          assert.strictEqual(event.content.meta[TEST_STATUS], 'fail')
          assert.strictEqual(event.content.error, 1)
          assert.match(event.content.meta[ERROR_MESSAGE], /custom Mocha reporter failed/)
        }
      },
      { hardTimeout: 20_000 }
    )

    const [[exitCode]] = await Promise.all([
      once(childProcess, 'exit'),
      eventsPromise,
    ])
    assert.match(testOutput, /custom Mocha reporter failed/)
    assert.match(testOutput, /MOCHA RUNNER OWNS EMIT: false/)
    assert.notStrictEqual(exitCode, 0, testOutput)
  })

  onlyLatestIt('does not schedule parallel workers when the coordinator reporter throws on start', async function () {
    this.timeout(20_000)
    childProcess = exec(
      'node node_modules/mocha/bin/mocha --parallel --jobs 2' +
      ' ./ci-visibility/mocha-plugin-tests/reporter-run-start.js' +
      ' ./ci-visibility/test/ci-visibility-test-2.js' +
      ' --reporter ./ci-visibility/mocha-reporter-throws.js',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          MOCHA_REPORTER_THROW_EVENT: 'start',
        },
      }
    )
    childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
    childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

    const eventsPromise = receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url.endsWith('/api/v2/citestcycle'),
      (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        assert.strictEqual(events.some(event => event.type === 'test'), false)
        assert.strictEqual(events.some(event => event.type === 'test_suite_end'), false)
        for (const eventType of ['test_session_end', 'test_module_end']) {
          const event = events.find(event => event.type === eventType)
          assert.ok(event, `expected ${eventType} event`)
          assert.strictEqual(event.content.meta[TEST_STATUS], 'fail')
          assert.strictEqual(event.content.error, 1)
          assert.match(event.content.meta[ERROR_MESSAGE], /custom Mocha reporter failed/)
        }
      },
      { hardTimeout: 20_000 }
    )

    const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
    assert.match(testOutput, /custom Mocha reporter failed/)
    assert.doesNotMatch(testOutput, /MOCHA (?:BEFORE|AFTER|TEST)/)
    assert.notStrictEqual(exitCode, 0, testOutput)
  })

  for (const reporterEvent of ['test', 'hook end']) {
    onlyLatestIt(`restores reusable Mocha state after a reporter throws on ${reporterEvent}`, async function () {
      this.timeout(20_000)
      childProcess = exec('node ./ci-visibility/run-mocha-reporter-rerun.js', {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          MOCHA_REUSABLE_REPORTER_EVENT: reporterEvent,
        },
      })
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

      const eventsPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testEvents = events.filter(event =>
            event.type === 'test' &&
            event.content.meta[TEST_NAME] === 'mocha-reporter-reusable-run runs again after reporter recovery'
          )
          assert.deepStrictEqual(
            testEvents.map(event => event.content.meta[TEST_STATUS]).sort(),
            ['pass', 'skip'],
            testOutput
          )
          const sessionEvents = events.filter(event => event.type === 'test_session_end')
          assert.deepStrictEqual(
            sessionEvents.map(event => event.content.meta[TEST_STATUS]).sort(),
            ['fail', 'pass'],
            testOutput
          )
        },
        { hardTimeout: 20_000 }
      )

      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
      assert.strictEqual(exitCode, 0, testOutput)
      assert.match(testOutput, /MOCHA FIRST RUN ERROR: custom reusable Mocha reporter failed/)
      assert.match(testOutput, /MOCHA SECOND RUN FAILURES: 0/)
      assert.strictEqual((testOutput.match(/MOCHA REUSABLE SECOND HOOK EXECUTED/g) || []).length, 1)
      assert.strictEqual((testOutput.match(/MOCHA REUSABLE TEST EXECUTED/g) || []).length, 1)
    })
  }

  onlyLatestIt('propagates a reporter error when the programmatic run callback throws', async function () {
    this.timeout(20_000)
    childProcess = exec('node ./ci-visibility/run-mocha-reporter-rerun.js', {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        MOCHA_REUSABLE_REPORTER_EVENT: 'test',
        MOCHA_REUSABLE_RUN_CALLBACK_THROWS: '1',
      },
    })
    childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
    childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

    const eventsPromise = receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url.endsWith('/api/v2/citestcycle'),
      (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        for (const eventType of ['test_session_end', 'test_module_end', 'test_suite_end']) {
          const event = events.find(event => event.type === eventType)
          assert.ok(event, `expected ${eventType} event`)
          assert.strictEqual(event.content.meta[TEST_STATUS], 'fail')
          assert.match(event.content.meta[ERROR_MESSAGE], /custom reusable Mocha reporter failed/)
        }
      },
      { hardTimeout: 20_000 }
    )

    const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
    assert.notStrictEqual(exitCode, 0, testOutput)
    assert.match(testOutput, /MOCHA RUN CALLBACK EXECUTED/)
    assert.match(testOutput, /MOCHA PROPAGATED ERROR: custom reusable Mocha reporter failed/)
  })

  onlyLatestIt('reports tests again when the same Mocha instance runs twice successfully', async function () {
    this.timeout(20_000)
    childProcess = exec('node ./ci-visibility/run-mocha-reporter-rerun.js', {
      cwd,
      env: getCiVisAgentlessConfig(receiver.port),
    })
    childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
    childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

    const eventsPromise = receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url.endsWith('/api/v2/citestcycle'),
      (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testEvents = events.filter(event =>
          event.type === 'test' &&
          event.content.meta[TEST_NAME] === 'mocha-reporter-reusable-run runs again after reporter recovery'
        )
        assert.strictEqual(testEvents.length, 2)
        assert.deepStrictEqual(testEvents.map(event => event.content.meta[TEST_STATUS]), ['pass', 'pass'])
        const sessionEvents = events.filter(event => event.type === 'test_session_end')
        assert.strictEqual(sessionEvents.length, 2)
        assert.deepStrictEqual(sessionEvents.map(event => event.content.meta[TEST_STATUS]), ['pass', 'pass'])
      },
      { hardTimeout: 20_000 }
    )

    const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
    assert.strictEqual(exitCode, 0, testOutput)
    assert.strictEqual((testOutput.match(/MOCHA REUSABLE TEST EXECUTED/g) || []).length, 2)
  })

  onlyLatestIt('restores native retry context when the same Mocha instance runs again', async function () {
    this.timeout(20_000)
    const testName = 'mocha-reporter-reusable-run runs again after reporter recovery'
    childProcess = exec('node ./ci-visibility/run-mocha-reporter-rerun.js', {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        MOCHA_REUSABLE_LOG_ACTIVE_TEST: '1',
        MOCHA_REUSABLE_NATIVE_RETRY: '1',
      },
    })
    childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
    childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

    const eventsPromise = receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url.endsWith('/api/v2/citestcycle'),
      (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testEvents = events.filter(event =>
          event.type === 'test' && event.content.meta[TEST_NAME] === testName
        )
        assert.deepStrictEqual(
          testEvents.map(event => event.content.meta[TEST_STATUS]),
          ['fail', 'pass', 'fail', 'pass']
        )
        const activeTestSpanIds = [...testOutput.matchAll(/MOCHA REUSABLE ACTIVE TEST: ([0-9]+)/g)]
          .map(match => match[1])
          .sort()
        assert.deepStrictEqual(
          activeTestSpanIds,
          testEvents.map(event => event.content.span_id.toString()).sort()
        )
      },
      { hardTimeout: 20_000 }
    )

    const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
    assert.strictEqual(exitCode, 0, testOutput)
    assert.strictEqual((testOutput.match(/MOCHA REUSABLE TEST EXECUTED/g) || []).length, 4)
  })

  onlyLatestIt('restores EFD test context and retry policy when the same Mocha instance runs again', async function () {
    this.timeout(20_000)
    const firstRetryCount = 1
    const secondRetryCount = 2
    const testName = 'mocha-reporter-reusable-run runs again after reporter recovery'
    receiver.setKnownTests({ mocha: {} })
    receiver.setSettingsResponses([
      {
        early_flake_detection: {
          enabled: true,
          slow_test_retries: { '5s': firstRetryCount },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      },
      {
        early_flake_detection: {
          enabled: true,
          slow_test_retries: { '5s': secondRetryCount },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      },
    ])
    childProcess = exec('node ./ci-visibility/run-mocha-reporter-rerun.js', {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        MOCHA_REUSABLE_LOG_ACTIVE_TEST: '1',
      },
    })
    childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
    childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

    const eventsPromise = receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url.endsWith('/api/v2/citestcycle'),
      (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testEvents = events.filter(event =>
          event.type === 'test' && event.content.meta[TEST_NAME] === testName
        )
        const expectedExecutions = firstRetryCount + secondRetryCount + 2
        assert.strictEqual(testEvents.length, expectedExecutions, testOutput)
        const activeTestSpanIds = [...testOutput.matchAll(/MOCHA REUSABLE ACTIVE TEST: ([0-9]+)/g)]
          .map(match => match[1])
          .sort()
        assert.deepStrictEqual(
          activeTestSpanIds,
          testEvents.map(event => event.content.span_id.toString()).sort()
        )
      },
      { hardTimeout: 20_000 }
    )

    const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
    assert.strictEqual(exitCode, 0, testOutput)
    assert.strictEqual(
      (testOutput.match(/MOCHA REUSABLE TEST EXECUTED/g) || []).length,
      firstRetryCount + secondRetryCount + 2
    )
  })

  onlyLatestIt('restores native retries after EFD is disabled for a reusable run', async function () {
    this.timeout(20_000)
    const testName = 'mocha-reporter-reusable-run runs again after reporter recovery'
    receiver.setKnownTests({ mocha: {} })
    receiver.setSettingsResponses([
      {
        early_flake_detection: {
          enabled: true,
          slow_test_retries: { '5s': 1 },
          faulty_session_threshold: 100,
        },
        known_tests_enabled: true,
      },
      {
        early_flake_detection: { enabled: false },
        known_tests_enabled: false,
      },
    ])
    childProcess = exec('node ./ci-visibility/run-mocha-reporter-rerun.js', {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        MOCHA_REUSABLE_NATIVE_RETRY: '1',
      },
    })
    childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
    childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

    const eventsPromise = receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url.endsWith('/api/v2/citestcycle'),
      (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testEvents = events.filter(event =>
          event.type === 'test' && event.content.meta[TEST_NAME] === testName
        )
        assert.deepStrictEqual(
          testEvents.map(event => event.content.meta[TEST_STATUS]),
          ['fail', 'pass', 'fail', 'pass']
        )
      },
      { hardTimeout: 20_000 }
    )

    const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
    assert.strictEqual(exitCode, 0, testOutput)
    assert.strictEqual((testOutput.match(/MOCHA REUSABLE TEST EXECUTED/g) || []).length, 4)
  })

  onlyLatestIt('restores a Test Management disabled test before the next run', async function () {
    this.timeout(20_000)
    const testName = 'mocha-reporter-reusable-run runs again after reporter recovery'
    receiver.setSettings({
      early_flake_detection: { enabled: false },
      test_management: { enabled: true },
    })
    receiver.setTestManagementTestResponses([
      {
        mocha: {
          suites: {
            'ci-visibility/mocha-plugin-tests/reporter-reusable-run.js': {
              tests: {
                [testName]: { properties: { disabled: true } },
              },
            },
          },
        },
      },
      {},
    ])
    childProcess = exec('node ./ci-visibility/run-mocha-reporter-rerun.js', {
      cwd,
      env: getCiVisAgentlessConfig(receiver.port),
    })
    childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
    childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

    const eventsPromise = receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url.endsWith('/api/v2/citestcycle'),
      (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testEvents = events.filter(event =>
          event.type === 'test' && event.content.meta[TEST_NAME] === testName
        )
        assert.deepStrictEqual(testEvents.map(event => event.content.meta[TEST_STATUS]), ['skip', 'pass'])
        assert.strictEqual(testEvents[0].content.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
        assert.ok(!(TEST_MANAGEMENT_IS_DISABLED in testEvents[1].content.meta))
      },
      { hardTimeout: 20_000 }
    )

    const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
    assert.strictEqual(exitCode, 0, testOutput)
    assert.strictEqual((testOutput.match(/MOCHA REUSABLE TEST EXECUTED/g) || []).length, 1)
  })

  onlyLatestIt('restores attempt-to-fix retries when the same Mocha instance runs again', async function () {
    this.timeout(20_000)
    const retryCount = 2
    const testName = 'mocha-reporter-reusable-run runs again after reporter recovery'
    receiver.setSettings({
      early_flake_detection: { enabled: false },
      test_management: { enabled: true, attempt_to_fix_retries: retryCount },
    })
    receiver.setTestManagementTests({
      mocha: {
        suites: {
          'ci-visibility/mocha-plugin-tests/reporter-reusable-run.js': {
            tests: {
              [testName]: { properties: { attempt_to_fix: true } },
            },
          },
        },
      },
    })
    childProcess = exec('node ./ci-visibility/run-mocha-reporter-rerun.js', {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        MOCHA_REUSABLE_REPORTER_EVENT: 'test',
      },
    })
    childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
    childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

    const eventsPromise = receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url.endsWith('/api/v2/citestcycle'),
      (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testEvents = events.filter(event =>
          event.type === 'test' && event.content.meta[TEST_NAME] === testName
        )
        assert.strictEqual(testEvents.filter(event => event.content.meta[TEST_STATUS] === 'skip').length, 1)
        const passedEvents = testEvents.filter(event => event.content.meta[TEST_STATUS] === 'pass')
        assert.strictEqual(passedEvents.length, retryCount + 1)
        assert.strictEqual(passedEvents.at(-1).content.meta[TEST_FINAL_STATUS], 'pass')
      },
      { hardTimeout: 20_000 }
    )

    const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
    assert.strictEqual(exitCode, 0, testOutput)
    assert.strictEqual((testOutput.match(/MOCHA REUSABLE TEST EXECUTED/g) || []).length, retryCount + 1)
  })

  onlyLatestIt('restores native retries after attempt-to-fix is removed for a reusable run', async function () {
    this.timeout(20_000)
    const testName = 'mocha-reporter-reusable-run runs again after reporter recovery'
    receiver.setSettings({
      early_flake_detection: { enabled: false },
      test_management: { enabled: true, attempt_to_fix_retries: 1 },
    })
    receiver.setTestManagementTestResponses([
      {
        mocha: {
          suites: {
            'ci-visibility/mocha-plugin-tests/reporter-reusable-run.js': {
              tests: {
                [testName]: { properties: { attempt_to_fix: true } },
              },
            },
          },
        },
      },
      {},
    ])
    childProcess = exec('node ./ci-visibility/run-mocha-reporter-rerun.js', {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        MOCHA_REUSABLE_NATIVE_RETRY: '1',
      },
    })
    childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
    childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

    const eventsPromise = receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url.endsWith('/api/v2/citestcycle'),
      (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testEvents = events.filter(event =>
          event.type === 'test' && event.content.meta[TEST_NAME] === testName
        )
        assert.deepStrictEqual(
          testEvents.map(event => event.content.meta[TEST_STATUS]),
          ['fail', 'pass', 'fail', 'pass']
        )
      },
      { hardTimeout: 20_000 }
    )

    const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
    assert.strictEqual(exitCode, 0, testOutput)
    assert.strictEqual((testOutput.match(/MOCHA REUSABLE TEST EXECUTED/g) || []).length, 4)
  })

  it('can run tests and report tests with the APM protocol (old agents)', (done) => {
    receiver.setInfoResponse({ endpoints: [] })
    receiver.payloadReceived(({ url }) => url === '/v0.4/traces').then(({ payload }) => {
      const testSpans = payload.flatMap(trace => trace)
      const resourceNames = testSpans.map(span => span.resource)

      assertObjectContains(resourceNames,
        [
          'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests',
          'ci-visibility/test/ci-visibility-test-2.js.ci visibility 2 can report tests 2',
        ]
      )

      const areAllTestSpans = testSpans.every(span => span.name === 'mocha.test')
      assert.strictEqual(areAllTestSpans, true)

      assert.match(testOutput, new RegExp(expectedStdout))

      if (extraStdout) {
        assert.match(testOutput, new RegExp(extraStdout))
      }
      // Can read DD_TAGS
      testSpans.forEach(testSpan => {
        assert.strictEqual(testSpan.meta['test.customtag'], 'customvalue')
        assert.strictEqual(testSpan.meta['test.customtag2'], 'customvalue2')
      })

      testSpans.forEach(testSpan => {
        assert.strictEqual(testSpan.meta[TEST_SOURCE_FILE].startsWith('ci-visibility/test/ci-visibility-test'), true)
        assert.ok(testSpan.metrics[TEST_SOURCE_START])
      })

      done()
    })

    childProcess = fork(startupTestFile, {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: receiver.port,
        NODE_OPTIONS: '-r dd-trace/ci/init',
        DD_TAGS: 'test.customtag:customvalue,test.customtag2:customvalue2',
      },
      stdio: 'pipe',
    })
    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
  })

  // TODO: This should also run in agentless mode
  it('sends telemetry with test_session metric when telemetry is enabled', async () => {
    receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })

    const telemetryPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/apmtelemetry'), (payloads) => {
        const telemetryMetrics = payloads.flatMap(({ payload }) => payload.payload.series)

        const testSessionMetric = telemetryMetrics.find(
          ({ metric }) => metric === 'test_session'
        )

        assert.ok(testSessionMetric, 'test_session telemetry metric should be sent')
      })

    childProcess = exec(
      runTestsCommand,
      {
        cwd,
        env: {
          ...getCiVisEvpProxyConfig(receiver.port),
          DD_TRACE_AGENT_PORT: String(receiver.port),
          DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'true',
        },
      }
    )

    await Promise.all([
      once(childProcess, 'exit'),
      telemetryPromise,
    ])
  })

  parallelIt('forwards telemetry from parallel workers', async () => {
    receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })

    const telemetryPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/apmtelemetry'), (payloads) => {
        const telemetryMetrics = payloads.flatMap(({ payload }) => payload.payload.series)
        const testFinishedMetric = telemetryMetrics.find(({ metric, tags }) =>
          metric === 'event_finished' && tags.includes('event_type:test')
        )

        assert.ok(testFinishedMetric, 'test event telemetry from a worker should be sent')
      })

    childProcess = exec(
      runTestsCommand,
      {
        cwd,
        env: {
          ...getCiVisEvpProxyConfig(receiver.port),
          DD_TRACE_AGENT_PORT: String(receiver.port),
          DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'true',
          RUN_IN_PARALLEL: '1',
        },
      }
    )

    await Promise.all([
      once(childProcess, 'exit'),
      telemetryPromise,
    ])
  })

  /**
   * @param {boolean} runInParallel
   * @returns {Promise<void>}
   */
  async function assertProgrammaticRunWaitsForFinalPayload (runInParallel) {
    const completionOrder = []
    const completedMessage = 'programmatic Mocha run completed'
    receiver.setWaitingTime(500)

    const intakePromise = (async () => {
      await receiver.payloadReceived(({ url, payload }) => (
        url === '/api/v2/citestcycle' &&
        payload.events.some(event => event.type === 'test_session_end')
      ))
      completionOrder.push('intake')
    })()

    childProcess = exec(
      runTestsCommand,
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          REPORT_RUN_CALLBACK: '1',
          ...(runInParallel && { RUN_IN_PARALLEL: '1' }),
        },
      }
    )
    childProcess.stdout?.on('data', (chunk) => {
      const output = chunk.toString()
      testOutput += output
      if (output.includes(completedMessage)) completionOrder.push('run')
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })

    const [[exitCode]] = await Promise.all([
      once(childProcess, 'exit'),
      intakePromise,
    ])

    assert.strictEqual(exitCode, 0, testOutput)
    assert.deepStrictEqual(completionOrder, ['intake', 'run'], testOutput)
  }

  for (const runInParallel of [false, true]) {
    const mode = runInParallel ? 'parallel' : 'serial'
    onlyLatestIt(`waits for the final payload before invoking the programmatic run callback (${mode})`, async () => {
      await assertProgrammaticRunWaitsForFinalPayload(runInParallel)
    })
  }

  onlyLatestIt('requests library configuration once with the programmatic API', async function () {
    this.timeout(20_000)
    childProcess = exec(runTestsCommand, {
      cwd,
      env: getCiVisAgentlessConfig(receiver.port),
    })
    childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
    childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

    const settingsPromise = receiver.gatherPayloadsUntilChildExit(
      childProcess,
      ({ url }) => url.endsWith('/api/v2/libraries/tests/services/setting'),
      payloads => assert.strictEqual(payloads.length, 1),
      { hardTimeout: 20_000 }
    )

    const [[exitCode]] = await Promise.all([
      once(childProcess, 'exit'),
      settingsPromise,
    ])
    assert.strictEqual(exitCode, 0, testOutput)
  })

  const nonLegacyReportingOptions = ['evp proxy', 'agentless']

  nonLegacyReportingOptions.forEach((reportingOption) => {
    let envVars = /** @type {typeof process.env} */ ({})
    context(`(${reportingOption}) can run and report`, () => {
      beforeEach(() => {
        if (reportingOption === 'agentless') {
          envVars = getCiVisAgentlessConfig(receiver.port)
        } else {
          envVars = getCiVisEvpProxyConfig(receiver.port)
          receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })
        }
      })

      it('tests with custom tags', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('citestcycle'), (payloads) => {
            const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

            metadataDicts.forEach(metadata => {
              assert.strictEqual(metadata.test_levels[TEST_SESSION_NAME], 'my-test-session')
            })

            const events = payloads.flatMap(({ payload }) => payload.events)
            const sessionEventContent = events.find(event => event.type === 'test_session_end').content
            const moduleEventContent = events.find(event => event.type === 'test_module_end').content
            const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const resourceNames = tests.map(span => span.resource)

            assertObjectContains(resourceNames,
              [
                'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests',
                'ci-visibility/test/ci-visibility-test-2.js.ci visibility 2 can report tests 2',
              ]
            )
            assert.strictEqual(suites.length, 2)
            assert.ok(sessionEventContent)
            assert.ok(moduleEventContent)

            tests.forEach(testEvent => {
              assert.strictEqual(
                testEvent.meta[TEST_SOURCE_FILE].startsWith('ci-visibility/test/ci-visibility-test'),
                true
              )
              assert.ok(testEvent.metrics[TEST_SOURCE_START])
              assert.strictEqual(testEvent.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'false')
              // Can read DD_TAGS
              assert.strictEqual(testEvent.meta['test.customtag'], 'customvalue')
              assert.strictEqual(testEvent.meta['test.customtag2'], 'customvalue2')
              assert.ok(testEvent.metrics[DD_HOST_CPU_COUNT])
            })

            suites.forEach(testSuite => {
              assert.strictEqual(
                testSuite.meta[TEST_SOURCE_FILE].startsWith('ci-visibility/test/ci-visibility-test'),
                true
              )
              assert.strictEqual(testSuite.metrics[TEST_SOURCE_START], 1)
              assert.ok(testSuite.metrics[DD_HOST_CPU_COUNT])
            })
          })

        childProcess = fork(startupTestFile, {
          cwd,
          env: {
            ...envVars,
            DD_TAGS: 'test.customtag:customvalue,test.customtag2:customvalue2',
            DD_TEST_SESSION_NAME: 'my-test-session',
            DD_SERVICE: undefined,
          },
          stdio: 'pipe',
        })

        childProcess.stdout?.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr?.on('data', (chunk) => {
          testOutput += chunk.toString()
        })

        await Promise.all([
          eventsPromise,
          once(childProcess.stdout, 'end'),
          once(childProcess.stderr, 'end'),
          once(childProcess, 'exit'),
        ])
        assert.match(testOutput, new RegExp(expectedStdout))
        assert.match(testOutput, new RegExp(extraStdout))
      })

      it('passing tests', async () => {
        const testNames = [
          'mocha-test-pass can pass',
          'mocha-test-pass can pass two',
          'mocha-test-pass-two can pass',
          'mocha-test-pass-two can pass two',
        ]
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            assert.strictEqual(tests.length, 4)
            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), testNames)

            tests.forEach(test => {
              assert.strictEqual(test.parent_id.toString(), '0')
              assert.strictEqual(test.meta[TEST_STATUS], 'pass')
              assert.strictEqual(test.meta[ORIGIN_KEY], CI_APP_ORIGIN)
              assert.ok(test.meta[TEST_FRAMEWORK_VERSION])
              assert.strictEqual(test.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
              assert.strictEqual(test.meta[LIBRARY_VERSION], ddTraceVersion)
              assert.strictEqual(test.meta[COMPONENT], 'mocha')
            })
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/passing.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('failing tests', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.ok(test.metrics[TEST_SOURCE_START])
            assert.ok(test.meta[ERROR_STACK])
            assert.strictEqual(test.parent_id.toString(), '0')
            assertObjectContains(test, {
              type: 'test',
              name: 'mocha.test',
              resource: 'ci-visibility/mocha-plugin-tests/failing.js.mocha-test-fail can fail',
              meta: {
                [COMPONENT]: 'mocha',
                language: 'javascript',
                [TEST_NAME]: 'mocha-test-fail can fail',
                [TEST_STATUS]: 'fail',
                [TEST_TYPE]: 'test',
                [TEST_FRAMEWORK]: 'mocha',
                [TEST_SUITE]: 'ci-visibility/mocha-plugin-tests/failing.js',
                [TEST_SOURCE_FILE]: 'ci-visibility/mocha-plugin-tests/failing.js',
                [ERROR_TYPE]: 'AssertionError',
                [ERROR_MESSAGE]: 'Expected values to be strictly equal:\n\ntrue !== false\n',
                [ORIGIN_KEY]: CI_APP_ORIGIN,
                [TEST_CODE_OWNERS]: JSON.stringify(['@datadog-dd-trace-js']),
                [LIBRARY_VERSION]: ddTraceVersion,
              },
            })
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/failing.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('skipping tests', async () => {
        const testNames = [
          'mocha-test-skip can skip',
          'mocha-test-skip-different can skip too',
          'mocha-test-skip-different can skip twice',
          'mocha-test-programmatic-skip can skip too',
        ]
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 4)
            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), testNames)

            tests.forEach(test => {
              assert.strictEqual(test.parent_id.toString(), '0')
              assert.strictEqual(test.meta[TEST_STATUS], 'skip')
              assert.strictEqual(test.meta[ORIGIN_KEY], CI_APP_ORIGIN)
              assert.strictEqual(test.meta[COMPONENT], 'mocha')
              assert.strictEqual(test.meta[TEST_TYPE], 'test')
              assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
              assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/skipping.js')
              assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/skipping.js')
            })
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/skipping.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('passing tests using done()', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-test-done-pass can do passed tests with done')
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            assert.strictEqual(test.meta[TEST_TYPE], 'test')
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/done-pass.js')
            assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/done-pass.js')
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/done-pass.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('failing tests using done()', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-test-done-fail can do failed tests with done')
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
            assert.strictEqual(test.meta[TEST_TYPE], 'test')
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/done-fail.js')
            assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/done-fail.js')
            assert.strictEqual(test.meta[ERROR_TYPE], 'AssertionError')
            assert.strictEqual(test.meta[ERROR_MESSAGE], 'Expected values to be strictly equal:\n\ntrue !== false\n')
            assert.ok(test.meta[ERROR_STACK])
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/done-fail.js',
          {
            cwd,
            env: getCiVisAgentlessConfig(receiver.port),
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('passing tests using promises', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-test-promise-pass can do passed promise tests')
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            assert.strictEqual(test.meta[TEST_TYPE], 'test')
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/promise-pass.js')
            assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/promise-pass.js')
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/promise-pass.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('failing tests using promises', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-test-promise-fail can do failed promise tests')
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
            assert.strictEqual(test.meta[TEST_TYPE], 'test')
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/promise-fail.js')
            assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/promise-fail.js')
            assert.strictEqual(test.meta[ERROR_TYPE], 'AssertionError')
            assert.strictEqual(test.meta[ERROR_MESSAGE], 'Expected values to be strictly equal:\n\ntrue !== false\n')
            assert.ok(test.meta[ERROR_STACK])
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/promise-fail.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('passing tests using async/await', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-test-async-pass can do passed async tests')
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            assert.strictEqual(test.meta[TEST_TYPE], 'test')
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/async-pass.js')
            assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/async-pass.js')
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/async-pass.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('failing tests using async/await', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-test-async-fail can do failed async tests')
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
            assert.strictEqual(test.meta[TEST_TYPE], 'test')
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/async-fail.js')
            assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/async-fail.js')
            assert.strictEqual(test.meta[ERROR_TYPE], 'AssertionError')
            assert.strictEqual(test.meta[ERROR_MESSAGE], 'Expected values to be strictly equal:\n\ntrue !== false\n')
            assert.ok(test.meta[ERROR_STACK])
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/async-fail.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('tests that time out', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-test-timeout-fail times out')
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
            assert.strictEqual(test.meta[TEST_TYPE], 'test')
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/timeout-fail.js')
            assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/timeout-fail.js')
            assert.strictEqual(test.meta[ERROR_TYPE], 'Error')
            assert.match(test.meta[ERROR_MESSAGE], /Timeout/)
            assert.ok(test.meta[ERROR_STACK])
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/timeout-fail.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('passing tests that use setTimeout', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-test-timeout-pass does not timeout')
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            assert.strictEqual(test.meta[TEST_TYPE], 'test')
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/timeout-pass.js')
            assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/timeout-pass.js')
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/timeout-pass.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('parameterized tests', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-parameterized can do parameterized')
            assert.strictEqual(test.meta[TEST_STATUS], 'pass')
            assert.strictEqual(test.meta[TEST_TYPE], 'test')
            assert.strictEqual(test.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(test.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/parameterized.js')
            assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/parameterized.js')
            assert.strictEqual(test.meta[TEST_PARAMETERS], JSON.stringify({ arguments: [1, 2, 3], metadata: {} }))
            assert.ok(test.metrics[TEST_SOURCE_START])
            assert.strictEqual(test.parent_id.toString(), '0')
            assert.strictEqual(test.type, 'test')
            assert.strictEqual(test.name, 'mocha.test')
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/parameterized.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('integration tests with http', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const spans = events.filter(event => event.type === 'span').map(event => event.content)

            assert.strictEqual(tests.length, 1)
            const [testSpan] = tests

            const httpSpan = spans.find(span => span.name === 'http.request')
            assert.ok(httpSpan)

            // Test span assertions
            assert.strictEqual(testSpan.meta[COMPONENT], 'mocha')
            assert.strictEqual(testSpan.meta[TEST_NAME], 'mocha-test-integration-http can do integration http')
            assert.strictEqual(testSpan.meta[TEST_STATUS], 'pass')
            assert.strictEqual(testSpan.meta[TEST_FRAMEWORK], 'mocha')
            assert.strictEqual(testSpan.meta[TEST_SUITE], 'ci-visibility/mocha-plugin-tests/integration.js')
            assert.strictEqual(testSpan.meta[TEST_SOURCE_FILE], 'ci-visibility/mocha-plugin-tests/integration.js')
            assert.strictEqual(testSpan.meta[ORIGIN_KEY], CI_APP_ORIGIN)
            assert.ok(testSpan.metrics[TEST_SOURCE_START])
            assert.strictEqual(testSpan.parent_id.toString(), '0')

            // HTTP span assertions
            assert.strictEqual(httpSpan.meta[ORIGIN_KEY], CI_APP_ORIGIN)
            const endpointUrl = envVars.DD_CIVISIBILITY_AGENTLESS_URL ||
              `http://127.0.0.1:${envVars.DD_TRACE_AGENT_PORT}`
            assert.strictEqual(httpSpan.meta['http.url'], `${endpointUrl}/info`)
            assert.strictEqual(httpSpan.parent_id.toString(), testSpan.span_id.toString(),
              'HTTP span should be child of test span')
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/integration.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('tests with sync errors in hooks', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
            assert.strictEqual(test.meta[ERROR_TYPE], 'TypeError')
            const errorMessage = test.meta[ERROR_MESSAGE]
            const expectedHookPrefix =
              'mocha-fail-hook-sync "before each" hook for "will not run but be reported as failed":'
            assert.ok(errorMessage.includes(expectedHookPrefix), `Got: ${inspect(errorMessage)}`)
            assert.match(errorMessage, /Cannot set /)
            assert.ok(test.meta[ERROR_STACK])
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/hook-sync-error.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('tests using active span in hooks', async () => {
        const testNames = [
          'mocha-active-span-in-hooks first test',
          'mocha-active-span-in-hooks second test',
        ]
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 2)
            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), testNames)

            tests.forEach(test => {
              assert.strictEqual(test.meta[TEST_STATUS], 'pass')
              assert.strictEqual(test.meta[COMPONENT], 'mocha')
            })
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/active-span-hooks.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('tests with async errors in hooks', async () => {
        const testNames = [
          {
            name: 'mocha-fail-hook-async will run but be reported as failed',
            status: 'fail',
            errorMsg: 'mocha-fail-hook-async "after each" hook for "will run but be reported as failed": yeah error',
          },
          {
            name: 'mocha-fail-hook-async-other will run and be reported as passed',
            status: 'pass',
          },
          {
            name: 'mocha-fail-hook-async-other-before will not run and be reported as failed',
            status: 'fail',
            errorMsg: 'mocha-fail-hook-async-other-before ' +
              '"before each" hook for "will not run and be reported as failed": yeah error',
          },
          {
            name: 'mocha-fail-hook-async-other-second-after will run and be reported as failed',
            status: 'fail',
            errorMsg: 'mocha-fail-hook-async-other-second-after ' +
              '"after each" hook for "will run and be reported as failed": yeah error',
          },
          {
            name: 'mocha-fail-test-after-each-passes will fail and be reported as failed',
            status: 'fail',
          },
        ]
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 5)

            testNames.forEach(({ name, status, errorMsg }) => {
              const test = tests.find(t => t.meta[TEST_NAME] === name)
              assert.ok(test)
              assert.strictEqual(test.meta[TEST_STATUS], status)
              assert.strictEqual(test.meta[COMPONENT], 'mocha')
              if (errorMsg) {
                assert.strictEqual(test.meta[ERROR_MESSAGE].startsWith(errorMsg), true)
                assert.strictEqual(test.meta[ERROR_TYPE], 'Error')
                assert.ok(test.meta[ERROR_STACK])
              }
            })
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/hook-async-error.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('tests with done callback fail', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[COMPONENT], 'mocha')
            assert.strictEqual(test.meta[TEST_NAME], 'mocha-test-done-fail can do badly setup failed tests with done')
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
            assert.strictEqual(test.meta[ERROR_TYPE], 'AssertionError')
            assert.strictEqual(test.meta[ERROR_MESSAGE], 'Expected values to be strictly equal:\n\ntrue !== false\n')
            assert.ok(test.meta[ERROR_STACK])
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/done-fail-badly.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      reporterFinalizationIt('tests with retries', async () => {
        // retry handler was released in mocha@6.0.0
        // so the reported data changes between mocha versions
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            if (supportsMochaRetryEvents) {
              assert.strictEqual(tests.length, 16)
            } else {
              // In old mocha (< 6.0.0), retries.js reports only final results (2 tests).
              // retries-with-hooks.js reports each attempt because afterEach hooks trigger
              // getOnHookEndHandler on every retry (3 pass attempts + 5 fail attempts = 8).
              assert.strictEqual(tests.length, 10)
            }

            const eventuallyPassingTests = tests.filter(t =>
              t.meta[TEST_NAME] === 'mocha-test-retries will be retried and pass'
            )
            if (supportsMochaRetryEvents) {
              assert.strictEqual(eventuallyPassingTests.length, 3)
            } else {
              assert.strictEqual(eventuallyPassingTests.length, 1)
            }

            const failedTests = tests.filter(t =>
              t.meta[TEST_NAME] === 'mocha-test-retries will be retried and fail' &&
              t.meta[TEST_STATUS] === 'fail'
            )
            if (supportsMochaRetryEvents) {
              assert.strictEqual(failedTests.length, 5)
            } else {
              assert.strictEqual(failedTests.length, 1)
            }

            // With afterEach hooks — retry tags should still be set correctly
            if (supportsMochaRetryEvents) {
              const hooksPassTests = tests.filter(t =>
                t.meta[TEST_NAME] === 'mocha-test-retries-with-hooks will be retried and pass'
              )
              assert.strictEqual(hooksPassTests.length, 3)
              const hooksPassRetries = hooksPassTests.filter(t => t.meta[TEST_IS_RETRY] === 'true')
              assert.strictEqual(hooksPassRetries.length, 2)
              hooksPassRetries.forEach(t => {
                assert.strictEqual(t.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.ext)
              })

              const hooksFailTests = tests.filter(t =>
                t.meta[TEST_NAME] === 'mocha-test-retries-with-hooks will be retried and fail' &&
                t.meta[TEST_STATUS] === 'fail'
              )
              assert.strictEqual(hooksFailTests.length, 5)
              const hooksFailRetries = hooksFailTests.filter(t => t.meta[TEST_IS_RETRY] === 'true')
              assert.strictEqual(hooksFailRetries.length, 4)
              hooksFailRetries.forEach(t => {
                assert.strictEqual(t.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.ext)
              })
            }
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha' +
          ' ./ci-visibility/mocha-plugin-tests/retries.js' +
          ' ./ci-visibility/mocha-hooks/retries-with-hooks.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('tests when skipping "describe"', async () => {
        const testNames = [
          { name: 'mocha-test-skip-describe will be skipped', status: 'skip' },
          { name: 'mocha-test-skip-describe-pass will pass', status: 'pass' },
        ]
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 2)

            testNames.forEach(({ name, status }) => {
              const test = tests.find(t => t.meta[TEST_NAME] === name)
              assert.ok(test)
              assert.strictEqual(test.meta[TEST_STATUS], status)
              assert.strictEqual(test.meta[COMPONENT], 'mocha')
            })
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/skip-describe.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      it('should create events for session, modules, suites and test', async () => {
        const suites = [
          'ci-visibility/mocha-plugin-tests/suite-level-fail-after-each.js',
          'ci-visibility/mocha-plugin-tests/suite-level-fail-skip-describe.js',
          'ci-visibility/mocha-plugin-tests/suite-level-fail-test.js',
          'ci-visibility/mocha-plugin-tests/suite-level-pass.js',
        ]

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('citestcycle'), (payloads) => {
            if (reportingOption === 'evp proxy') {
              const headers = payloads.map(({ headers }) => headers)
              headers.forEach(header => {
                assert.strictEqual(header['x-datadog-evp-subdomain'], 'citestcycle-intake')
              })
              const urls = payloads.map(({ url }) => url)
              urls.forEach(url => {
                assert.strictEqual(url, '/evp_proxy/v4/api/v2/citestcycle')
              })
            }

            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSessionEvent = events.find(event => event.type === 'test_session_end')?.content
            const testModuleEvent = events.find(event => event.type === 'test_module_end')?.content
            const testSuiteEvents = events.filter(event => event.type === 'test_suite_end').map(e => e.content)

            assert.ok(testSessionEvent)
            assert.ok(testModuleEvent)
            assert.strictEqual(testSuiteEvents.length, 4, 'Should have 4 test suite events')

            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testModuleEvent.meta[TEST_STATUS], 'fail')

            // Check that all suites have the same session ID
            assert.ok(
              testSuiteEvents.every(
                suite => suite.test_session_id.toString() === testSessionEvent.test_session_id.toString()
              ),
              'All suites should have the same test_session_id'
            )

            // Check that all suites have the same module ID
            assert.ok(
              testSuiteEvents.every(
                suite => suite.test_module_id.toString() === testModuleEvent.test_module_id.toString()
              ),
              'All suites should have the same test_module_id'
            )

            // Check that all suites have a test_suite_id
            assert.strictEqual(
              testSuiteEvents.every(suite => suite.test_suite_id !== undefined),
              true,
              'All suites should have a test_suite_id'
            )

            // Check that all suites match expected suite names
            assert.ok(
              testSuiteEvents.every(suite => suites.includes(suite.meta[TEST_SUITE])),
              'All suites should match expected suite names'
            )

            const failedSuites = testSuiteEvents.filter(suite => suite.meta[TEST_STATUS] === 'fail')
            const passedSuites = testSuiteEvents.filter(suite => suite.meta[TEST_STATUS] === 'pass')

            assert.strictEqual(passedSuites.length, 1, 'Should have 1 passing suite')
            assert.strictEqual(failedSuites.length, 3, 'Should have 3 failing suites')
            assert.ok(
              failedSuites.every(suite => suite.meta[ERROR_MESSAGE] !== undefined),
              'All failed suites should have an error message'
            )
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha ./ci-visibility/mocha-plugin-tests/suite-level-*.js',
          {
            cwd,
            env: envVars,
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })

      context('suite reporting - tests with no describe wrapper', () => {
        // When a test file uses only top-level it() calls (no describe() block),
        // mocha never emits a non-root 'suite' event for that file.
        //
        // The 'suite' handler in packages/datadog-instrumentations/src/mocha/main.js
        // only fires testSuiteStartCh when it encounters a non-root suite with
        // suite.tests.length > 0. With no non-root suites at all, the condition is
        // never met: no suite context is stored in testFileToSuiteCtx, no suite
        // span is created by the plugin, and no test_suite_end event is emitted.
        //
        // Meanwhile tests run and report normally as mocha.test spans.

        it('reports a suite event for a single file with only top-level tests', async () => {
          const suiteFile = 'ci-visibility/mocha-plugin-tests/top-level-it-no-describe.js'
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(e => e.content)
              const suiteEvents = events.filter(event => event.type === 'test_suite_end').map(e => e.content)

              assert.strictEqual(tests.length, 2)
              assert.strictEqual(suiteEvents.length, 1)
              assertObjectContains(suiteEvents[0], { meta: { [TEST_SUITE]: suiteFile, [TEST_STATUS]: 'pass' } })
              tests.forEach(test => assert.strictEqual(test.meta[TEST_SUITE], suiteFile))
            })

          childProcess = exec(
            `node node_modules/mocha/bin/mocha ./${suiteFile}`,
            { cwd, env: envVars }
          )

          await Promise.all([eventsPromise, once(childProcess, 'exit')])
        })

        it('reports suite events for two files with only top-level tests', async () => {
          const suiteFiles = [
            'ci-visibility/mocha-plugin-tests/top-level-it-no-describe.js',
            'ci-visibility/mocha-plugin-tests/top-level-it-no-describe2.js',
          ]
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(e => e.content)
              const suiteEvents = events.filter(event => event.type === 'test_suite_end').map(e => e.content)

              assert.strictEqual(tests.length, 4)
              assert.strictEqual(suiteEvents.length, 2)
              suiteFiles.forEach(suiteFile => {
                const suite = suiteEvents.find(e => e.meta[TEST_SUITE] === suiteFile)
                assert.ok(suite, `Expected suite event for ${suiteFile}`)
                assert.strictEqual(suite.meta[TEST_STATUS], 'pass')
              })
              tests.forEach(test => assert.ok(
                suiteFiles.includes(test.meta[TEST_SUITE]),
                `Got: ${inspect(suiteFiles)}`
              ))
            })

          childProcess = exec(
            'node node_modules/mocha/bin/mocha' +
            ` ./${suiteFiles[0]} ./${suiteFiles[1]}`,
            { cwd, env: envVars }
          )

          await Promise.all([eventsPromise, once(childProcess, 'exit')])
        })

        it('reports a suite event for a file with mixed top-level and nested tests', async () => {
          const suiteFile = 'ci-visibility/mocha-plugin-tests/top-level-it-mixed.js'
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(e => e.content)
              const suiteEvents = events.filter(event => event.type === 'test_suite_end').map(e => e.content)

              assert.strictEqual(tests.length, 2)
              assert.strictEqual(suiteEvents.length, 1)
              assertObjectContains(suiteEvents[0], { meta: { [TEST_SUITE]: suiteFile, [TEST_STATUS]: 'pass' } })
              tests.forEach(test => assert.strictEqual(test.meta[TEST_SUITE], suiteFile))
            })

          childProcess = exec(
            `node node_modules/mocha/bin/mocha ./${suiteFile}`,
            { cwd, env: envVars }
          )

          await Promise.all([eventsPromise, once(childProcess, 'exit')])
        })

        it('reports suite events for two files with mixed top-level and nested tests', async () => {
          const suiteFiles = [
            'ci-visibility/mocha-plugin-tests/top-level-it-mixed.js',
            'ci-visibility/mocha-plugin-tests/top-level-it-mixed2.js',
          ]
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(e => e.content)
              const suiteEvents = events.filter(event => event.type === 'test_suite_end').map(e => e.content)

              assert.strictEqual(tests.length, 4)
              assert.strictEqual(suiteEvents.length, 2)
              suiteFiles.forEach(suiteFile => {
                const suite = suiteEvents.find(e => e.meta[TEST_SUITE] === suiteFile)
                assert.ok(suite, `Expected suite event for ${suiteFile}`)
                assert.strictEqual(suite.meta[TEST_STATUS], 'pass')
              })
              tests.forEach(test => assert.ok(
                suiteFiles.includes(test.meta[TEST_SUITE]),
                `Got: ${inspect(suiteFiles)}`
              ))
            })

          childProcess = exec(
            'node node_modules/mocha/bin/mocha' +
            ` ./${suiteFiles[0]} ./${suiteFiles[1]}`,
            { cwd, env: envVars }
          )

          await Promise.all([eventsPromise, once(childProcess, 'exit')])
        })

        it('reports fail status when a top-level test fails alongside passing nested tests', async () => {
          const suiteFile = 'ci-visibility/mocha-plugin-tests/top-level-it-mixed-failing.js'
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const suiteEvents = events.filter(event => event.type === 'test_suite_end').map(e => e.content)

              assert.strictEqual(suiteEvents.length, 1)
              assertObjectContains(suiteEvents[0], { meta: { [TEST_SUITE]: suiteFile, [TEST_STATUS]: 'fail' } })
            })

          childProcess = exec(
            `node node_modules/mocha/bin/mocha ./${suiteFile}`,
            { cwd, env: envVars }
          )

          await Promise.all([eventsPromise, once(childProcess, 'exit')])
        })

        it('reports a suite event when a beforeEach hook fails on top-level tests', async () => {
          const suiteFile = 'ci-visibility/mocha-plugin-tests/top-level-it-with-failing-hook.js'
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(e => e.content)
              const suiteEvents = events.filter(event => event.type === 'test_suite_end').map(e => e.content)

              assert.strictEqual(suiteEvents.length, 1)
              assertObjectContains(suiteEvents[0], { meta: { [TEST_SUITE]: suiteFile, [TEST_STATUS]: 'fail' } })
              // beforeEach failure aborts after the first test starts — only 1 test span is emitted
              assert.strictEqual(tests.length, 1)
              assert.strictEqual(tests[0].meta[TEST_STATUS], 'fail')
            })

          childProcess = exec(
            `node node_modules/mocha/bin/mocha ./${suiteFile}`,
            { cwd, env: envVars }
          )

          await Promise.all([eventsPromise, once(childProcess, 'exit')])
        })

        for (const mode of ['all', 'first', 'last', 'mixed']) {
          it(`associates skipped top-level tests with their suite (${mode})`, async () => {
            const suiteFile = 'ci-visibility/mocha-plugin-tests/top-level-it-skipped.js'
            childProcess = exec(`node node_modules/mocha/bin/mocha ./${suiteFile}`, {
              cwd,
              env: { ...envVars, DD_INJECT_FORCE: 'true', MOCHA_TOP_LEVEL_SKIP_MODE: mode },
            })

            const eventsPromise = receiver.gatherPayloadsUntilChildExit(childProcess,
              ({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)

                assert.strictEqual(suites.length, 1)
                assert.strictEqual(tests.length, mode === 'mixed' ? 3 : 2)
                assertObjectContains(suites[0], {
                  meta: { [TEST_SUITE]: suiteFile, [TEST_STATUS]: mode === 'all' ? 'skip' : 'pass' },
                })
                for (const test of tests) {
                  assert.ok(test.test_suite_id, 'Skipped tests must reference their suite')
                  assert.strictEqual(test.test_suite_id.toString(), suites[0].test_suite_id.toString())
                }
                const skippedTests = tests.filter(test => test.meta[TEST_STATUS] === 'skip')
                assert.strictEqual(skippedTests.length, mode === 'all' || mode === 'mixed' ? 2 : 1)
              })

            const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
            assert.strictEqual(exitCode, 0)
          })
        }

        for (const followingFile of ['top-level-it-no-describe.js', 'top-level-it-with-hooks.js']) {
          it(`finishes skipped root files before ${followingFile}`, async () => {
            const skippedFile = 'ci-visibility/mocha-plugin-tests/top-level-it-skipped.js'
            const passingFile = `ci-visibility/mocha-plugin-tests/${followingFile}`
            childProcess = exec(`node node_modules/mocha/bin/mocha ./${skippedFile} ./${passingFile}`, {
              cwd,
              env: { ...envVars, DD_INJECT_FORCE: 'true' },
            })

            const eventsPromise = receiver.gatherPayloadsUntilChildExit(childProcess,
              ({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
                assert.strictEqual(suites.length, 2)
                const skippedSuite = suites.find(suite => suite.meta[TEST_SUITE] === skippedFile)
                const passingSuite = suites.find(suite => suite.meta[TEST_SUITE] === passingFile)
                assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
                assert.strictEqual(passingSuite.meta[TEST_STATUS], 'pass')
                assert.ok(skippedSuite.start + BigInt(skippedSuite.duration) <= passingSuite.start,
                  'Skipped files must finish before the following file starts')
                assert.strictEqual(tests.length, 4)
                for (const test of tests) {
                  const suite = test.meta[TEST_SUITE] === skippedFile ? skippedSuite : passingSuite
                  assert.strictEqual(test.test_suite_id.toString(), suite.test_suite_id.toString())
                }
              })

            const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
            assert.strictEqual(exitCode, 0)
          })
        }

        for (const { hook, skippedFileFirst, reporterThrows } of [
          { hook: 'beforeEach', skippedFileFirst: false, reporterThrows: false },
          { hook: 'afterEach', skippedFileFirst: false, reporterThrows: false },
          { hook: 'beforeEach', skippedFileFirst: false, reporterThrows: true },
          { hook: 'afterEach', skippedFileFirst: false, reporterThrows: true },
          { hook: 'afterEach', skippedFileFirst: true, reporterThrows: false },
        ]) {
          it(`preserves top-level suite coverage after an aborting ${hook}` +
            ` (skipped file first=${skippedFileFirst}, reporter throws=${reporterThrows})`, async () => {
            const suiteFile = 'ci-visibility/mocha-plugin-tests/top-level-it-aborted.js'
            const skippedFile = 'ci-visibility/mocha-plugin-tests/top-level-it-skipped.js'
            const files = skippedFileFirst ? `./${skippedFile} ./${suiteFile}` : `./${suiteFile}`
            receiver.setSettings({ itr_enabled: true, code_coverage: true, tests_skipping: false })
            childProcess = exec(
              `node node_modules/nyc/bin/nyc.js --silent node node_modules/mocha/bin/mocha ${files}` +
              ' --reporter ./ci-visibility/mocha-root-coverage-reporter.js',
              {
                cwd,
                env: {
                  ...envVars,
                  DD_INJECT_FORCE: 'true',
                  MOCHA_FAILING_HOOK: hook,
                  MOCHA_COVERAGE_REPORTER_THROWS: reporterThrows ? '1' : '',
                },
              }
            )
            childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
            childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

            const payloadsPromise = receiver.gatherPayloadsUntilChildExit(childProcess,
              ({ url }) => url.endsWith('/api/v2/citestcycle') || url.endsWith('/api/v2/citestcov'), payloads => {
                const events = payloads.filter(({ url }) => url.endsWith('/api/v2/citestcycle'))
                  .flatMap(({ payload }) => payload.events)
                const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
                const coverages = payloads.filter(({ url }) => url.endsWith('/api/v2/citestcov'))
                  .flatMap(({ payload }) => payload).flatMap(({ content }) => content.coverages)

                assert.strictEqual(suites.length, skippedFileFirst ? 2 : 1)
                const abortedSuite = suites.find(suite => suite.meta[TEST_SUITE] === suiteFile)
                assert.strictEqual(abortedSuite.meta[TEST_STATUS], 'fail')
                assert.strictEqual(coverages.length, suites.length)
                const abortedCoverage = coverages.find(coverage =>
                  coverage.test_suite_id === Number(abortedSuite.test_suite_id))
                assertObjectContains(abortedCoverage.files.map(({ filename }) => filename), [
                  suiteFile,
                  'ci-visibility/test/sum.js',
                ])
                const abortedSum = abortedCoverage.files.find(
                  ({ filename }) => filename === 'ci-visibility/test/sum.js')
                assert.ok(abortedSum.bitmap[0] & (1 << 4), 'The aborted file must own coverage of the sum body')
                if (skippedFileFirst) {
                  const skippedSuite = suites.find(suite => suite.meta[TEST_SUITE] === skippedFile)
                  const skippedCoverage = coverages.find(coverage =>
                    coverage.test_suite_id === Number(skippedSuite.test_suite_id))
                  assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
                  const skippedSum = skippedCoverage.files.find(
                    ({ filename }) => filename === 'ci-visibility/test/sum.js')
                  assert.strictEqual((skippedSum?.bitmap[0] || 0) & (1 << 4), 0,
                    'Skipped files must not receive coverage executed by a later file')
                }
              })

            const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), payloadsPromise])
            assert.strictEqual(exitCode, 1, testOutput)
            assert.match(testOutput, /MOCHA ROOT REPORTER COVERAGE: 1/)
            assert.match(testOutput, /MOCHA ROOT COVERAGE AFTER REPORTERS: 0/)
          })
        }

        for (const invert of [false, true]) {
          it(`keeps filtered root-file coverage separate (invert=${invert})`, async () => {
            const suiteFiles = [
              'ci-visibility/mocha-plugin-tests/top-level-it-filtered.js',
              'ci-visibility/mocha-plugin-tests/top-level-it-filtered2.js',
            ]
            const grep = invert ? '--grep excluded --invert' : '--grep included'
            receiver.setSettings({ itr_enabled: true, code_coverage: true, tests_skipping: false })
            childProcess = exec(
              'node node_modules/nyc/bin/nyc.js --silent node node_modules/mocha/bin/mocha ' +
              `${suiteFiles.join(' ')} ${grep} --reporter ./ci-visibility/mocha-root-coverage-reporter.js`,
              { cwd, env: { ...envVars, DD_INJECT_FORCE: 'true' } }
            )
            childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
            childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

            const payloadsPromise = receiver.gatherPayloadsUntilChildExit(childProcess,
              ({ url }) => url.endsWith('/api/v2/citestcycle') || url.endsWith('/api/v2/citestcov'), payloads => {
                const events = payloads.filter(({ url }) => url.endsWith('/api/v2/citestcycle'))
                  .flatMap(({ payload }) => payload.events)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
                const coverages = payloads.filter(({ url }) => url.endsWith('/api/v2/citestcov'))
                  .flatMap(({ payload }) => payload).flatMap(({ content }) => content.coverages)

                assert.strictEqual(tests.length, 2)
                assert.strictEqual(suites.length, 2)
                assert.strictEqual(coverages.length, 2)
                const [suiteA, suiteB] = suiteFiles.map(file => suites.find(suite => suite.meta[TEST_SUITE] === file))
                assert.ok(suiteA.start + BigInt(suiteA.duration) <= suiteB.start,
                  'Filtered files must finish at their own execution boundary')
                for (const suite of suites) {
                  assert.strictEqual(suite.meta[TEST_STATUS], 'pass')
                  const coverage = coverages.find(item => item.test_suite_id === Number(suite.test_suite_id))
                  const ownFile = coverage.files.find(({ filename }) => filename === suite.meta[TEST_SUITE])
                  assert.ok(ownFile.bitmap[0] & (1 << 6), 'Each suite must cover its own executed test body')
                  const otherFile = suiteFiles.find(file => file !== suite.meta[TEST_SUITE])
                  const otherCoverage = coverage.files.find(({ filename }) => filename === otherFile)
                  assert.strictEqual((otherCoverage?.bitmap[0] || 0) & (1 << 6), 0,
                    'A suite must not claim the other file\'s executed test body')
                }
              })

            const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), payloadsPromise])
            assert.strictEqual(exitCode, 0, testOutput)
            assert.match(testOutput, /MOCHA RESTORED SUM HITS: 2/)
          })

          it(`keeps filtered skipped root suites skipped (invert=${invert})`, async () => {
            const suiteFile = 'ci-visibility/mocha-plugin-tests/top-level-it-skipped.js'
            const grep = invert ? '--grep second --invert' : '--grep first'
            childProcess = exec(`node node_modules/mocha/bin/mocha ./${suiteFile} ${grep}`, {
              cwd,
              env: { ...envVars, DD_INJECT_FORCE: 'true', MOCHA_TOP_LEVEL_SKIP_MODE: 'first' },
            })

            const eventsPromise = receiver.gatherPayloadsUntilChildExit(childProcess,
              ({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
                assert.strictEqual(tests.length, 1)
                assert.strictEqual(tests[0].meta[TEST_STATUS], 'skip')
                assert.strictEqual(suites.length, 1)
                assert.strictEqual(suites[0].meta[TEST_STATUS], 'skip')
                assert.strictEqual(tests[0].test_suite_id.toString(), suites[0].test_suite_id.toString())
              })

            const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
            assert.strictEqual(exitCode, 0)
          })
        }

        context('suite span timing', () => {
          it('suite spans for top-level-only files are bounded to their own file execution', async () => {
            const suiteFiles = [
              'ci-visibility/mocha-plugin-tests/top-level-it-no-describe.js',
              'ci-visibility/mocha-plugin-tests/top-level-it-no-describe2.js',
            ]
            let suiteEvents = []
            let tests = []

            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                tests = events.filter(e => e.type === 'test').map(e => e.content)
                suiteEvents = events.filter(e => e.type === 'test_suite_end').map(e => e.content)
                assert.strictEqual(suiteEvents.length, 2)
                assert.strictEqual(tests.length, 4)
              })

            childProcess = exec(
              `node node_modules/mocha/bin/mocha ./${suiteFiles[0]} ./${suiteFiles[1]}`,
              { cwd, env: envVars }
            )

            await Promise.all([eventsPromise, once(childProcess, 'exit')])

            const [suiteA, suiteB] = suiteFiles.map(f => suiteEvents.find(e => e.meta[TEST_SUITE] === f))

            for (const suiteFile of suiteFiles) {
              const suite = suiteEvents.find(e => e.meta[TEST_SUITE] === suiteFile)
              const suiteTests = tests.filter(t => t.meta[TEST_SUITE] === suiteFile)
              const firstTestStart = suiteTests.reduce(
                (min, t) => t.start < min ? t.start : min, suiteTests[0].start
              )
              assert.ok(suite.start <= firstTestStart,
                `Suite for ${suiteFile} must start at or before its first test`)
            }

            assert.notStrictEqual(suiteA.start, suiteB.start,
              'Suite spans for different files must not start simultaneously')

            // Files run fully sequentially: suite A must finish before suite B starts
            assert.ok(
              suiteA.start + BigInt(suiteA.duration) <= suiteB.start,
              'Suite A must end before suite B starts'
            )
          })

          it('suite spans for files with afterEach hooks are bounded to their own file execution', async () => {
            const suiteFiles = [
              'ci-visibility/mocha-plugin-tests/top-level-it-with-hooks.js',
              'ci-visibility/mocha-plugin-tests/top-level-it-with-hooks2.js',
            ]
            let suiteEvents = []
            let tests = []

            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                tests = events.filter(e => e.type === 'test').map(e => e.content)
                suiteEvents = events.filter(e => e.type === 'test_suite_end').map(e => e.content)
                assert.strictEqual(suiteEvents.length, 2)
                assert.strictEqual(tests.length, 4)
              })

            childProcess = exec(
              `node node_modules/mocha/bin/mocha ./${suiteFiles[0]} ./${suiteFiles[1]}`,
              { cwd, env: envVars }
            )

            await Promise.all([eventsPromise, once(childProcess, 'exit')])

            const [suiteA, suiteB] = suiteFiles.map(f => suiteEvents.find(e => e.meta[TEST_SUITE] === f))

            for (const suiteFile of suiteFiles) {
              const suite = suiteEvents.find(e => e.meta[TEST_SUITE] === suiteFile)
              const suiteTests = tests.filter(t => t.meta[TEST_SUITE] === suiteFile)
              const firstTestStart = suiteTests.reduce(
                (min, t) => t.start < min ? t.start : min, suiteTests[0].start
              )
              assert.ok(suite.start <= firstTestStart,
                `Suite for ${suiteFile} must start at or before its first test`)
            }

            assert.notStrictEqual(suiteA.start, suiteB.start,
              'Suite spans for different files must not start simultaneously')

            assert.ok(
              suiteA.start + BigInt(suiteA.duration) <= suiteB.start,
              'Suite A must end before suite B starts'
            )
          })

          // Mixed files have an inherent overlap: root tests from all files run before any
          // describes, so suite B starts while suite A is still open. What we can assert:
          // start times are ordered (a's root test runs before b's root test) and end times
          // are ordered (a's describe finishes before b's describe).
          it('suite spans for mixed files have ordered start and end times', async () => {
            const suiteFiles = [
              'ci-visibility/mocha-plugin-tests/top-level-it-mixed.js',
              'ci-visibility/mocha-plugin-tests/top-level-it-mixed2.js',
            ]
            let suiteEvents = []
            let tests = []

            const eventsPromise = receiver
              .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                tests = events.filter(e => e.type === 'test').map(e => e.content)
                suiteEvents = events.filter(e => e.type === 'test_suite_end').map(e => e.content)
                assert.strictEqual(suiteEvents.length, 2)
                assert.strictEqual(tests.length, 4)
              })

            childProcess = exec(
              `node node_modules/mocha/bin/mocha ./${suiteFiles[0]} ./${suiteFiles[1]}`,
              { cwd, env: envVars }
            )

            await Promise.all([eventsPromise, once(childProcess, 'exit')])

            const [suiteA, suiteB] = suiteFiles.map(f => suiteEvents.find(e => e.meta[TEST_SUITE] === f))

            for (const suiteFile of suiteFiles) {
              const suite = suiteEvents.find(e => e.meta[TEST_SUITE] === suiteFile)
              const suiteTests = tests.filter(t => t.meta[TEST_SUITE] === suiteFile)
              const firstTestStart = suiteTests.reduce(
                (min, t) => t.start < min ? t.start : min, suiteTests[0].start
              )
              assert.ok(suite.start <= firstTestStart,
                `Suite for ${suiteFile} must start at or before its first test`)
            }

            assert.ok(suiteA.start < suiteB.start, 'Suite A must start before suite B')

            assert.ok(
              suiteA.start + BigInt(suiteA.duration) < suiteB.start + BigInt(suiteB.duration),
              'Suite A must end before suite B ends'
            )
          })
        })
      })
    })
  })

  const envVarSettings = ['DD_TRACE_ENABLED']

  envVarSettings.forEach(envVar => {
    context(`when ${envVar}=false`, () => {
      it('does not report spans but still runs tests', (done) => {
        receiver.assertMessageReceived(() => {
          done(new Error('Should not create spans'))
        }).catch(() => {})

        childProcess = fork(startupTestFile, {
          cwd,
          env: {
            DD_TRACE_AGENT_PORT: receiver.port,
            NODE_OPTIONS: '-r dd-trace/ci/init',
            [envVar]: 'false',
          },
          stdio: 'pipe',
        })
        childProcess.stdout?.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr?.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.on('message', () => {
          assert.match(testOutput, new RegExp(expectedStdout))
          done()
        })
      })
    })
  })

  context('custom tagging', () => {
    it('can add custom tags to the tests', (done) => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const test = events.find(event => event.type === 'test').content

          assertObjectContains(test, {
            meta: {
              'custom_tag.beforeEach': 'true',
              'custom_tag.it': 'true',
              'custom_tag.afterEach': 'true',
            },
          })
        })

      childProcess = exec(
        runTestsCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './test-custom-tags/custom-tags.js',
            ]),
          },
        }
      )

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })
  })

  context('when no ci visibility init is used', () => {
    it('does not crash', (done) => {
      childProcess = fork(startupTestFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: receiver.port,
          NODE_OPTIONS: '-r dd-trace/init',
        },
        stdio: 'pipe',
      })
      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.on('message', () => {
        assert.doesNotMatch(testOutput, /TypeError/)
        assert.doesNotMatch(testOutput, /Uncaught error outside test suite/)
        assert.match(testOutput, new RegExp(expectedStdout))
        done()
      })
    })
  })

  it('correctly calculates test code owners when working directory is not repository root', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)

        const test = events.find(event => event.type === 'test').content
        const testSuite = events.find(event => event.type === 'test_suite_end').content
        // The test is in a subproject
        assert.notStrictEqual(test.meta[TEST_SOURCE_FILE], test.meta[TEST_SUITE])
        assert.strictEqual(test.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
        assert.strictEqual(testSuite.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
      })

    childProcess = exec(
      'node ../../node_modules/mocha/bin/mocha subproject-test.js',
      {
        cwd: `${cwd}/ci-visibility/subproject`,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
        },
      }
    )

    childProcess.on('exit', () => {
      eventsPromise.then(() => {
        done()
      }).catch(done)
    })
  })

  it('does not change mocha config if CI Visibility fails to init', (done) => {
    receiver.assertPayloadReceived(() => {
      const error = new Error('it should not report tests')
      done(error)
    }, ({ url }) => url === '/api/v2/citestcycle', 3000).catch(() => {})

    const { DD_CIVISIBILITY_AGENTLESS_URL, ...restEnvVars } = getCiVisAgentlessConfig(receiver.port)

    // `runMocha` is only executed when using the CLI, which is where we modify mocha config
    // if CI Visibility is init
    childProcess = exec('node node_modules/mocha/bin/mocha ./ci-visibility/test/ci-visibility-test.js', {
      cwd,
      env: {
        ...restEnvVars,
        DD_TRACE_DEBUG: '1',
        DD_TRACE_LOG_LEVEL: 'error',
        DD_SITE: '= invalid = url',
      },
    })

    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.on('exit', () => {
      assert.match(testOutput, /Invalid URL/)
      assert.match(testOutput, /1 passing/) // we only run one file here
      done()
    })
  })

  onlyLatestIt('works with parallel mode', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

        metadataDicts.forEach(metadata => {
          assert.ok(metadata.test_levels[TEST_COMMAND])
          assert.strictEqual(metadata.test_levels[TEST_SESSION_NAME], 'my-test-session')
        })

        const events = payloads.flatMap(({ payload }) => payload.events)
        const sessionEventContent = events.find(event => event.type === 'test_session_end').content
        const moduleEventContent = events.find(event => event.type === 'test_module_end').content
        const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)

        assert.strictEqual(sessionEventContent.meta[MOCHA_IS_PARALLEL], 'true')
        assert.strictEqual(
          sessionEventContent.test_session_id.toString(10),
          moduleEventContent.test_session_id.toString(10)
        )
        suites.forEach(({
          meta,
          test_suite_id: testSuiteId,
          test_module_id: testModuleId,
          test_session_id: testSessionId,
        }) => {
          assert.ok(meta[TEST_MODULE])
          assert.ok(testSuiteId)
          assert.strictEqual(testModuleId.toString(10), moduleEventContent.test_module_id.toString(10))
          assert.strictEqual(testSessionId.toString(10), moduleEventContent.test_session_id.toString(10))
        })

        tests.forEach(({
          meta,
          metrics,
          test_suite_id: testSuiteId,
          test_module_id: testModuleId,
          test_session_id: testSessionId,
        }) => {
          assert.ok(meta[TEST_MODULE])
          assert.ok(testSuiteId)
          assert.strictEqual(testModuleId.toString(10), moduleEventContent.test_module_id.toString(10))
          assert.strictEqual(testSessionId.toString(10), moduleEventContent.test_session_id.toString(10))
          assert.strictEqual(meta[MOCHA_IS_PARALLEL], 'true')
          assert.ok(metrics[TEST_SOURCE_START])
        })
      })

    childProcess = fork(testFile, {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        RUN_IN_PARALLEL: 'true',
        DD_TRACE_DEBUG: '1',
        DD_TRACE_LOG_LEVEL: 'warn',
        DD_TEST_SESSION_NAME: 'my-test-session',
      },
      stdio: 'pipe',
    })
    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.on('message', () => {
      eventsPromise.then(() => {
        assert.doesNotMatch(testOutput, /TypeError/)
        done()
      }).catch(done)
    })
  })

  onlyLatestIt('works with parallel mode when run with the cli', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const sessionEventContent = events.find(event => event.type === 'test_session_end').content
        const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)

        assert.strictEqual(sessionEventContent.meta[MOCHA_IS_PARALLEL], 'true')
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 2)
      })

    childProcess = exec(
      'node node_modules/mocha/bin/mocha --parallel --jobs 2 ./ci-visibility/test/ci-visibility-test*', {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
      })
    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.on('exit', () => {
      eventsPromise.then(() => {
        assert.doesNotMatch(testOutput, /TypeError/)
        done()
      }).catch(done)
    })
  })

  onlyLatestIt('correctly reports retries in parallel mode', async () => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const tests = events.filter(event => event.type === 'test').map(event => event.content)

        // Verify we are actually in parallel mode
        const sessionEvent = events.find(event => event.type === 'test_session_end').content
        assert.strictEqual(sessionEvent.meta[MOCHA_IS_PARALLEL], 'true')

        // Each file has 1 test that fails twice then passes on the 3rd attempt (3 events per file)
        assert.strictEqual(tests.length, 6)

        // 2 failed attempts per file = 4 total
        const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
        assert.strictEqual(failedTests.length, 4)

        // The 3rd attempt passes in each file = 2 total
        const passingTests = tests.filter(test => test.meta[TEST_STATUS] === 'pass')
        assert.strictEqual(passingTests.length, 2)

        // First attempt of each test is not a retry, subsequent ones are (2 retries * 2 files = 4)
        const retries = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
        assert.strictEqual(retries.length, 4)

        // Native --retries (not ATR), so retry reason should be 'external'
        retries.forEach(test => {
          assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.ext)
        })

        // Verify the two files ran in separate worker processes
        const testsBySuite = {}
        for (const test of tests) {
          const suiteName = test.meta[TEST_SUITE]
          if (!testsBySuite[suiteName]) {
            testsBySuite[suiteName] = test
          }
        }
        const testFromEachWorker = Object.values(testsBySuite)
        assert.strictEqual(testFromEachWorker.length, 2)
        const runtimeIds = testFromEachWorker.map(test => test.meta['runtime-id'])
        assert.ok(runtimeIds[0])
        assert.ok(runtimeIds[1])
        assert.notStrictEqual(runtimeIds[0], runtimeIds[1],
          'Tests from different files should have different runtime-ids (separate worker processes)'
        )
      })

    childProcess = exec(
      'node node_modules/mocha/bin/mocha' +
      ' --parallel --jobs 2 --retries 2' +
      ' ./ci-visibility/mocha-plugin-tests/retries-parallel.js' +
      ' ./ci-visibility/mocha-plugin-tests/retries-parallel-2.js',
      {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
      }
    )
    await Promise.all([
      eventsPromise,
      once(childProcess, 'exit'),
    ])
  })

  it('does not blow up when workerpool is used outside of a test', (done) => {
    childProcess = exec('node ./ci-visibility/run-workerpool.js', {
      cwd,
      env: getCiVisAgentlessConfig(receiver.port),
    })
    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.on('exit', (code) => {
      assert.match(testOutput, /result 7/)
      assert.strictEqual(code, 0)
      done()
    })
  })

  it('reports errors in test sessions', (done) => {
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testSession = events.find(event => event.type === 'test_session_end').content
        assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
        const errorMessage = 'Failed tests: 1'
        assert.match(testSession.meta[ERROR_MESSAGE], new RegExp(errorMessage))
      })

    childProcess = exec(
      runTestsCommand,
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          TESTS_TO_RUN: JSON.stringify([
            './test/fail-test.js',
          ]),
        },
      }
    )
    childProcess.on('exit', () => {
      eventsPromise.then(() => {
        done()
      }).catch(done)
    })
  })

  it('does not init if DD_API_KEY is not set', (done) => {
    receiver.assertMessageReceived(() => {
      done(new Error('Should not create spans'))
    }).catch(() => {})

    childProcess = fork(startupTestFile, {
      cwd,
      env: {
        DD_CIVISIBILITY_AGENTLESS_ENABLED: '1',
        NODE_OPTIONS: '-r dd-trace/ci/init',
      },
      stdio: 'pipe',
    })
    childProcess.stdout?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', (chunk) => {
      testOutput += chunk.toString()
    })
    childProcess.on('message', () => {
      assert.match(testOutput, new RegExp(expectedStdout))
      assert.match(
        testOutput,
        /DD_CIVISIBILITY_AGENTLESS_ENABLED is set, but neither DD_API_KEY nor DATADOG_API_KEY are set in your environment, so dd-trace will not be initialized./
      )
      done()
    })
  })

  it('can report git metadata', (done) => {
    const searchCommitsRequestPromise = receiver.payloadReceived(
      ({ url }) => url === '/api/v2/git/repository/search_commits'
    )
    const packfileRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/git/repository/packfile')
    const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle')

    Promise.all([
      searchCommitsRequestPromise,
      packfileRequestPromise,
      eventsRequestPromise,
    ]).then(([searchCommitRequest, packfileRequest, eventsRequest]) => {
      assert.strictEqual(searchCommitRequest.headers['dd-api-key'], '1')
      assert.strictEqual(packfileRequest.headers['dd-api-key'], '1')

      const eventTypes = eventsRequest.payload.events.map(event => event.type)
      assertObjectContains(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
      const numSuites = eventTypes.reduce(
        (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
      )
      assert.strictEqual(numSuites, 2)

      done()
    }).catch(done)

    childProcess = fork(startupTestFile, {
      cwd,
      env: getCiVisAgentlessConfig(receiver.port),
      stdio: 'pipe',
    })
  })

  it('keeps a root hook failure failed when no tests execute', async () => {
    const suiteFile = 'ci-visibility/mocha-plugin-tests/empty-session-failing-before.js'
    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)

        for (const eventType of ['test_session_end', 'test_module_end']) {
          const event = events.find(({ type }) => type === eventType)
          assert.ok(event, `expected ${eventType} event`)
          assert.strictEqual(event.content.meta[TEST_STATUS], 'fail')
          assert.strictEqual(event.content.meta[TEST_SKIP_REASON], undefined)
          assert.strictEqual(event.content.meta[TEST_SESSION_EMPTY_REASON], undefined)
        }
      })

    childProcess = exec(
      `node node_modules/mocha/bin/mocha ./${suiteFile}`,
      {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
      }
    )
    const [, [exitCode]] = await Promise.all([
      eventsPromise,
      once(childProcess, 'close'),
    ])
    assert.notStrictEqual(exitCode, 0)
  })

  context('intelligent test runner', () => {
    context('if the agent is not event platform proxy compatible', () => {
      it('does not do any intelligent test runner request', (done) => {
        receiver.setInfoResponse({ endpoints: [] })

        receiver.assertPayloadReceived(() => {
          const error = new Error('should not request search_commits')
          done(error)
        }, ({ url }) => url === '/evp_proxy/v2/api/v2/git/repository/search_commits').catch(() => {})
        receiver.assertPayloadReceived(() => {
          const error = new Error('should not request search_commits')
          done(error)
        }, ({ url }) => url === '/api/v2/git/repository/search_commits').catch(() => {})
        receiver.assertPayloadReceived(() => {
          const error = new Error('should not request setting')
          done(error)
        }, ({ url }) => url === '/api/v2/libraries/tests/services/setting').catch(() => {})
        receiver.assertPayloadReceived(() => {
          const error = new Error('should not request setting')
          done(error)
        }, ({ url }) => url === '/evp_proxy/v2/api/v2/libraries/tests/services/setting').catch(() => {})

        receiver.assertPayloadReceived(({ payload }) => {
          const testSpans = payload.flatMap(trace => trace)
          const resourceNames = testSpans.map(span => span.resource)

          assertObjectContains(resourceNames,
            [
              'ci-visibility/test/ci-visibility-test.js.ci visibility can report tests',
              'ci-visibility/test/ci-visibility-test-2.js.ci visibility 2 can report tests 2',
            ]
          )
        }, ({ url }) => url === '/v0.4/traces').then(() => done()).catch(done)

        childProcess = fork(startupTestFile, {
          cwd,
          env: getCiVisEvpProxyConfig(receiver.port),
          stdio: 'pipe',
        })
      })
    })

    it('can report code coverage', async () => {
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: true,
        coverage_report_upload_enabled: true,
        tests_skipping: true,
      })

      let testOutput = ''
      const libraryConfigRequestPromise = receiver.payloadReceived(
        ({ url }) => url === '/api/v2/libraries/tests/services/setting'
      )
      const codeCovRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcov')
      const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle')

      const requestsPromise = Promise.all([
        libraryConfigRequestPromise,
        codeCovRequestPromise,
        eventsRequestPromise,
      ]).then(([libraryConfigRequest, codeCovRequest, eventsRequest]) => {
        assert.strictEqual(libraryConfigRequest.headers['dd-api-key'], '1')

        assertObjectContains(codeCovRequest, {
          headers: {
            'dd-api-key': '1',
          },
          payload: [{
            name: 'coverage1',
            filename: 'coverage1.msgpack',
            type: 'application/msgpack',
            content: {
              version: 2,
            },
          }],
        })

        const allCoverageFiles = codeCovRequest.payload
          .flatMap(coverage => coverage.content.coverages)
          .flatMap(file => file.files)
          .map(file => file.filename)

        assertObjectContains(allCoverageFiles,
          [
            'ci-visibility/test/sum.js',
            'ci-visibility/test/ci-visibility-test.js',
            'ci-visibility/test/ci-visibility-test-2.js',
          ]
        )

        const [coveragePayload] = codeCovRequest.payload
        assert.ok(coveragePayload.content.coverages[0].test_session_id)
        assert.ok(coveragePayload.content.coverages[0].test_suite_id)

        const testSession = eventsRequest.payload.events.find(event => event.type === 'test_session_end').content
        assert.ok(testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT])

        const eventTypes = eventsRequest.payload.events.map(event => event.type)
        assertObjectContains(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
        const numSuites = eventTypes.reduce(
          (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
        )
        assert.strictEqual(numSuites, 2)
      })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )
      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      const stdoutEndPromise = childProcess.stdout ? once(childProcess.stdout, 'end') : Promise.resolve()
      const [, [exitCode]] = await Promise.all([
        requestsPromise,
        once(childProcess, 'exit'),
        stdoutEndPromise,
      ])
      assert.strictEqual(exitCode, 0)
      // coverage report
      assert.match(testOutput, /Lines {7}/)
    })

    it('does not report code coverage if disabled by the API', (done) => {
      receiver.setSettings({
        itr_enabled: false,
        code_coverage: false,
        tests_skipping: false,
      })

      receiver.assertPayloadReceived(() => {
        const error = new Error('it should not report code coverage')
        done(error)
      }, ({ url }) => url === '/api/v2/citestcov').catch(() => {})

      receiver.assertPayloadReceived(({ headers, payload }) => {
        assert.strictEqual(headers['dd-api-key'], '1')
        const eventTypes = payload.events.map(event => event.type)
        assertObjectContains(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
        const testSession = payload.events.find(event => event.type === 'test_session_end').content
        assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'false')
        assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'false')
        assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'false')
        assert.ok(testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT])
        const testModule = payload.events.find(event => event.type === 'test_module_end').content
        assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'false')
        assert.strictEqual(testModule.meta[TEST_CODE_COVERAGE_ENABLED], 'false')
        assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_ENABLED], 'false')
        assertItrSkippingEnabledTags(payload.events, 'false')
      }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )
    })

    it('can skip suites received by the intelligent test runner API and still reports code coverage', async () => {
      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: {
          suite: 'ci-visibility/test/ci-visibility-test.js',
        },
      }])
      receiver.setSkippableCoverage({
        'ci-visibility/test/ci-visibility-test.js': getLinesBitmapBase64(1, 20),
      })

      const skippableRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/ci/tests/skippable')
      const coverageRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcov')
      const eventsRequestPromise = receiver.payloadReceived(({ url }) => url === '/api/v2/citestcycle')

      const requestsPromise = Promise.all([
        skippableRequestPromise,
        coverageRequestPromise,
        eventsRequestPromise,
      ]).then(([skippableRequest, coverageRequest, eventsRequest]) => {
        assert.strictEqual(skippableRequest.headers['dd-api-key'], '1')
        const [coveragePayload] = coverageRequest.payload
        assert.strictEqual(coverageRequest.headers['dd-api-key'], '1')
        assertObjectContains(coveragePayload, {
          name: 'coverage1',
          filename: 'coverage1.msgpack',
          type: 'application/msgpack',
        })

        assert.strictEqual(eventsRequest.headers['dd-api-key'], '1')
        const eventTypes = eventsRequest.payload.events.map(event => event.type)
        const skippedSuite = eventsRequest.payload.events.find(event =>
          event.content.resource === 'test_suite.ci-visibility/test/ci-visibility-test.js'
        ).content
        assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
        assert.strictEqual(skippedSuite.meta[TEST_SKIPPED_BY_ITR], 'true')

        assertObjectContains(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
        const numSuites = eventTypes.reduce(
          (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
        )
        assert.strictEqual(numSuites, 2)
        const testSession = eventsRequest.payload.events.find(event => event.type === 'test_session_end').content
        assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'true')
        assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
        assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
        assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_TYPE], 'suite')
        assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 1)
        const testModule = eventsRequest.payload.events.find(event => event.type === 'test_module_end').content
        assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'true')
        assert.strictEqual(testModule.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
        assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
        assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_TYPE], 'suite')
        assert.strictEqual(testModule.metrics[TEST_ITR_SKIPPING_COUNT], 1)
        assertItrSkippingEnabledTags(eventsRequest.payload.events, 'true')
      })

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )
      const [, [exitCode]] = await Promise.all([
        requestsPromise,
        once(childProcess, 'exit'),
      ])
      assert.strictEqual(exitCode, 0)
    })

    it('marks the test session as skipped if every suite is skipped', async () => {
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: false,
        tests_skipping: true,
      })
      receiver.setSuitesToSkip(
        [
          {
            type: 'suite',
            attributes: {
              suite: 'ci-visibility/test/ci-visibility-test.js',
            },
          },
          {
            type: 'suite',
            attributes: {
              suite: 'ci-visibility/test/ci-visibility-test-2.js',
            },
          },
        ]
      )

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_STATUS], 'skip')
        })
      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })
      const [, [exitCode]] = await Promise.all([
        eventsPromise,
        once(childProcess, 'close'),
      ])
      assert.strictEqual(exitCode, 0)
      assert.strictEqual(
        testOutput.split(TEST_IMPACT_ANALYSIS_ALL_TESTS_SKIPPED_MESSAGE).length - 1,
        1,
        testOutput
      )
    })

    it('does not say TIA skipped all tests when a root-level test still runs', async () => {
      const suiteFile = 'ci-visibility/test/ci-visibility-test.js'
      const rootFile = 'ci-visibility/mocha-plugin-tests/top-level-it-no-describe.js'
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: false,
        tests_skipping: true,
      })
      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: { suite: suiteFile },
      }])

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.strictEqual(tests.length, 2)
          assert.ok(tests.every(test => test.meta[TEST_SUITE] === rootFile))
        })

      childProcess = exec(
        `node node_modules/mocha/bin/mocha ./${suiteFile} ./${rootFile}`,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })
      const [, [exitCode]] = await Promise.all([
        eventsPromise,
        once(childProcess, 'close'),
      ])
      assert.strictEqual(exitCode, 0)
      assert.strictEqual(testOutput.includes(TEST_IMPACT_ANALYSIS_ALL_TESTS_SKIPPED_MESSAGE), false, testOutput)
    })

    describe('TIA skipping root-level tests', () => {
      const defaultFixtureRoot = 'ci-visibility/mocha-plugin-tests/'

      for (const scenario of [
        {
          name: 'skips a file containing only root-level tests',
          files: ['top-level-it-no-describe.js'],
          skippedFiles: ['top-level-it-no-describe.js'],
        },
        {
          name: 'skips root-level tests in multiple files',
          files: ['top-level-it-no-describe.js', 'top-level-it-no-describe2.js'],
          skippedFiles: ['top-level-it-no-describe.js', 'top-level-it-no-describe2.js'],
        },
        {
          name: 'preserves root-level tests from files not selected for skipping',
          files: ['top-level-it-no-describe.js', 'top-level-it-no-describe2.js'],
          skippedFiles: ['top-level-it-no-describe.js'],
          expectedTests: 2,
        },
        {
          name: 'skips root-level and nested tests in the same file once',
          files: ['top-level-it-mixed-failing.js'],
          skippedFiles: ['top-level-it-mixed-failing.js'],
        },
        {
          name: 'preserves nested and root-level tests in other files',
          files: ['top-level-it-mixed-failing.js', 'top-level-it-mixed2.js'],
          skippedFiles: ['top-level-it-mixed-failing.js'],
          expectedTests: 2,
        },
        {
          name: 'preserves unskippable root-level tests',
          files: ['top-level-it-no-describe.js', 'top-level-it-unskippable.js'],
          skippedFiles: ['top-level-it-no-describe.js'],
          expectedTests: 1,
        },
        ...['relative', 'absolute'].flatMap(programmatic => [
          {
            name: `preserves programmatic ${programmatic}-path unskippable root tests and hooks`,
            files: ['top-level-it-no-describe.js', 'top-level-it-unskippable.js'],
            skippedFiles: ['top-level-it-no-describe.js'],
            expectedTests: 1,
            programmatic,
          },
          {
            name: `preserves programmatic ${programmatic}-path unskippable nested tests`,
            files: ['test-to-skip.js', 'test-unskippable.js'],
            fixtureRoot: 'ci-visibility/unskippable-test/',
            skippedFiles: ['test-to-skip.js'],
            expectedTests: 1,
            programmatic,
          },
        ]),
        ...['before', 'after', 'beforeEach', 'afterEach'].flatMap(hookType => [
          {
            name: `removes ${hookType} hooks from skipped files`,
            files: ['top-level-it-skippable-hook.js', 'top-level-it-mixed2.js'],
            skippedFiles: ['top-level-it-skippable-hook.js'],
            expectedTests: 2,
            hookType,
          },
          {
            name: `preserves ${hookType} hooks from retained files`,
            files: ['top-level-it-skippable-hook.js', 'top-level-it-mixed2.js'],
            skippedFiles: ['top-level-it-mixed2.js'],
            expectedTests: 2,
            hookType,
            expectedHooks: hookType.endsWith('Each') ? 2 : 1,
          },
          {
            name: `removes ${hookType} hooks from symlinked skipped files`,
            files: [`top-level-it-skippable-${hookType}-link.js`, 'top-level-it-mixed2.js'],
            skippedFiles: [`top-level-it-skippable-${hookType}-link.js`],
            symlinkTarget: 'top-level-it-skippable-hook.js',
            expectedTests: 2,
            hookType,
          },
        ]),
        ...['plugins-false', 'use-false'].flatMap(latePluginMode =>
          ['before', 'after', 'beforeEach', 'afterEach'].map(hookType => ({
            name: `removes ${hookType} hooks after late plugin enablement (${latePluginMode})`,
            files: ['top-level-it-skippable-hook.js', 'top-level-it-mixed2.js'],
            skippedFiles: ['top-level-it-skippable-hook.js'],
            expectedTests: 2,
            hookType,
            latePluginMode,
          }))
        ),
        {
          name: 'removes a failing hook from a file containing only root-level tests',
          files: ['top-level-it-with-failing-hook.js', 'top-level-it-no-describe2.js'],
          skippedFiles: ['top-level-it-with-failing-hook.js'],
          expectedTests: 2,
        },
        {
          name: 'preserves global root hook plugins when skipping a file',
          files: ['top-level-it-no-describe.js', 'top-level-it-mixed2.js'],
          skippedFiles: ['top-level-it-no-describe.js'],
          expectedTests: 2,
          args: ' --require ./ci-visibility/mocha-plugin-tests/root-hook-plugin.js',
          rootHookPlugin: true,
        },
        {
          name: 'skips root-level tests selected by grep',
          files: ['top-level-it-mixed-failing.js'],
          skippedFiles: ['top-level-it-mixed-failing.js'],
          args: " --grep 'top-level'",
        },
        {
          name: 'skips exclusive root-level tests without restoring them',
          files: ['top-level-it-exclusive.js'],
          skippedFiles: ['top-level-it-exclusive.js'],
        },
        {
          name: 'skips root-level tests in an ES module',
          files: ['top-level-it-skippable.mjs'],
          skippedFiles: ['top-level-it-skippable.mjs'],
          esm: true,
        },
        {
          name: 'removes root hooks from an ES module while retaining other tests',
          files: ['top-level-it-skippable.mjs', 'top-level-it-mixed2.js'],
          skippedFiles: ['top-level-it-skippable.mjs'],
          expectedTests: 2,
          esm: true,
        },
        {
          name: 'preserves shared helper hooks when skipping their first importer',
          files: ['top-level-it-shared-hooks.js', 'top-level-it-shared-hooks-retained.js'],
          skippedFiles: ['top-level-it-shared-hooks.js'],
          expectedTests: 2,
        },
        {
          name: 'removes root hooks from a symlinked ES module while retaining other tests',
          files: ['top-level-it-skippable-link.mjs', 'top-level-it-mixed2.js'],
          skippedFiles: ['top-level-it-skippable-link.mjs'],
          symlinkTarget: 'top-level-it-skippable.mjs',
          expectedTests: 2,
          esm: true,
        },
        {
          name: 'runs bundled Mocha without module metadata and skips root-level tests',
          files: ['top-level-it-no-describe.js', 'top-level-it-mixed2.js'],
          skippedFiles: ['top-level-it-no-describe.js'],
          expectedTests: 2,
          bundled: true,
        },
        ...['before', 'after', 'beforeEach', 'afterEach'].flatMap(hookType => [
          ...[false, true].map(metadataAfterUi => ({
            name: `bundled Mocha removes ${hookType} hooks with metadata after UI=${metadataAfterUi}`,
            files: ['top-level-it-skippable-hook.js', 'top-level-it-mixed2.js'],
            skippedFiles: ['top-level-it-skippable-hook.js'],
            expectedTests: 2,
            hookType,
            bundled: true,
            metadataAfterUi,
          })),
          {
            name: `bundled Mocha preserves ${hookType} hooks from retained files`,
            files: ['top-level-it-skippable-hook.js', 'top-level-it-mixed2.js'],
            skippedFiles: ['top-level-it-mixed2.js'],
            expectedTests: 2,
            hookType,
            expectedHooks: hookType.endsWith('Each') ? 2 : 1,
            bundled: true,
          },
        ]),
        {
          name: 'preserves shared helper hooks in bundled Mocha',
          files: ['top-level-it-shared-hooks.js', 'top-level-it-shared-hooks-retained.js'],
          skippedFiles: ['top-level-it-shared-hooks.js'],
          expectedTests: 2,
          bundled: true,
        },
      ]) {
        const {
          name, files, skippedFiles, expectedTests = 0, args = '', esm = false,
          hookType, expectedHooks = 0, rootHookPlugin = false, latePluginMode, symlinkTarget, bundled = false,
          metadataAfterUi = false, programmatic, fixtureRoot = defaultFixtureRoot,
        } = scenario
        // Mocha added native ES module loading in 7.1.0.
        const unsupportedEsm = esm && MOCHA_VERSION !== 'latest' && !satisfies(MOCHA_VERSION, '>=7.1.0')
        // Root hook plugins were introduced in Mocha 8.0.0.
        const runTest = unsupportedEsm || (rootHookPlugin && mochaMajor < 8) ? it.skip : it
        runTest(name, async () => {
          if (symlinkTarget) fs.symlinkSync(symlinkTarget, path.join(cwd, fixtureRoot, files[0]))
          const suitesToSkip = files.filter(file => skippedFiles.includes(file) || file.includes('unskippable'))
          receiver.setSettings({ itr_enabled: true, code_coverage: false, tests_skipping: true })
          receiver.setSuitesToSkip(suitesToSkip.map(file => ({
            type: 'suite',
            attributes: { suite: fixtureRoot + file },
          })))

          const eventsPromise = receiver.gatherPayloadsMaxTimeout(
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              assert.strictEqual(tests.length, expectedTests)
              assert.ok(tests.every(test => !skippedFiles.includes(test.meta[TEST_SUITE].slice(fixtureRoot.length))))
              const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
              assert.strictEqual(suites.length, files.length)
              for (const file of files) {
                const suite = suites.find(suite => suite.meta[TEST_SUITE] === fixtureRoot + file)
                assert.ok(suite, file)
                assert.strictEqual(suite.meta[TEST_STATUS], skippedFiles.includes(file) ? 'skip' : 'pass')
                assert.strictEqual(suite.meta[TEST_SKIPPED_BY_ITR], skippedFiles.includes(file) ? 'true' : undefined)
                if (file.includes('unskippable')) {
                  assert.strictEqual(suite.meta[TEST_ITR_UNSKIPPABLE], 'true')
                  assert.strictEqual(suite.meta[TEST_ITR_FORCED_RUN], 'true')
                }
              }
              for (const type of ['test_session_end', 'test_module_end']) {
                const event = events.find(event => event.type === type).content
                assert.strictEqual(event.meta[TEST_STATUS], expectedTests ? 'pass' : 'skip')
                assert.strictEqual(event.meta[TEST_ITR_TESTS_SKIPPED], 'true')
                assert.strictEqual(event.metrics[TEST_ITR_SKIPPING_COUNT], skippedFiles.length)
              }
            }
          )
          const testFiles = files.map(file => programmatic === 'absolute'
            ? path.join(fs.realpathSync(cwd), fixtureRoot, file)
            : `./${fixtureRoot}${file}`).join(' ')
          const command = latePluginMode
            ? 'node ./ci-visibility/run-mocha-late-plugin.js'
            : bundled
              ? 'node ./ci-visibility/run-mocha-bundler.js'
              : programmatic
                ? 'node ./ci-visibility/run-mocha-tia-programmatic.js'
                : 'node node_modules/mocha/bin/mocha'
          const env = getCiVisAgentlessConfig(receiver.port)
          if (latePluginMode || bundled) env.NODE_OPTIONS = undefined
          childProcess = exec(`${command} ${testFiles}${args}`, {
            cwd,
            env: {
              ...env,
              MOCHA_LATE_PLUGIN_MODE: latePluginMode,
              MOCHA_BUNDLER_METADATA_AFTER_UI: String(metadataAfterUi),
              ROOT_HOOK_TYPE: hookType,
              ROOT_HOOK_FAIL: String(expectedHooks === 0),
            },
          })
          childProcess.stdout.on('data', chunk => { testOutput += chunk.toString() })
          childProcess.stderr.on('data', chunk => { testOutput += chunk.toString() })
          const [, [exitCode]] = await Promise.all([eventsPromise, once(childProcess, 'close')])
          assert.strictEqual(exitCode, 0, testOutput)
          assert.strictEqual(testOutput.includes(TEST_IMPACT_ANALYSIS_ALL_TESTS_SKIPPED_MESSAGE), expectedTests === 0)
          if (hookType) {
            assert.strictEqual(testOutput.split(`file-owned ${hookType} hook`).length - 1, expectedHooks, testOutput)
          }
          for (const hook of ['before', 'after', 'beforeEach', 'afterEach']) {
            if (files.includes('top-level-it-unskippable.js')) {
              assert.strictEqual(testOutput.split(`unskippable ${hook} hook`).length - 1, 1, testOutput)
            }
            if (args.includes('root-hook-plugin')) {
              const expectedCount = hook.endsWith('Each') ? expectedTests : 1
              assert.strictEqual(testOutput.split(`global ${hook} hook`).length - 1, expectedCount, testOutput)
            }
          }
          if (files.includes('top-level-it-shared-hooks.js')) {
            assert.strictEqual(testOutput.split('shared afterEach hook').length - 1, 2, testOutput)
            assert.strictEqual(testOutput.split('shared after hook').length - 1, 1, testOutput)
          }
        })
      }
    })

    describe('TIA root hooks with cross-file exclusivity', () => {
      const fixtureRoot = 'ci-visibility/mocha-plugin-tests/'
      for (const exclusiveFile of ['top-level-it-reusable-exclusive.js', 'top-level-suite-retained-exclusive.js']) {
        for (const hookType of ['before', 'after', 'beforeEach', 'afterEach']) {
          it(`removes ${hookType} hooks while retaining ${exclusiveFile}`, async () => {
            const skippedFile = fixtureRoot + 'top-level-it-skippable-hook.js'
            receiver.setSettings({ itr_enabled: true, code_coverage: false, tests_skipping: true })
            receiver.setSuitesToSkip([{ type: 'suite', attributes: { suite: skippedFile } }])
            childProcess = exec(`node node_modules/mocha/bin/mocha ./${skippedFile} ./${fixtureRoot}${exclusiveFile}`, {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                ROOT_HOOK_TYPE: hookType,
                ROOT_HOOK_FAIL: 'true',
              },
            })
            childProcess.stdout.on('data', chunk => { testOutput += chunk.toString() })
            childProcess.stderr.on('data', chunk => { testOutput += chunk.toString() })
            const eventsPromise = receiver.gatherPayloadsUntilChildExit(
              childProcess,
              ({ url }) => url.endsWith('/api/v2/citestcycle'),
              payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                for (const type of ['test', 'test_suite_end', 'test_module_end', 'test_session_end']) {
                  const matching = events.filter(event => event.type === type)
                  assert.strictEqual(matching.length, 1, testOutput)
                  assert.strictEqual(matching[0].content.meta[TEST_STATUS], 'pass', testOutput)
                }
                const test = events.find(event => event.type === 'test').content
                assert.strictEqual(test.meta[TEST_SUITE], fixtureRoot + exclusiveFile)
                const session = events.find(event => event.type === 'test_session_end').content
                assert.strictEqual(session.metrics[TEST_ITR_SKIPPING_COUNT], 0)
                assert.strictEqual(session.meta[TEST_ITR_TESTS_SKIPPED], 'false')
              }
            )
            const [[exitCode]] = await Promise.all([once(childProcess, 'close'), eventsPromise])
            assert.strictEqual(exitCode, 0, testOutput)
            assert.doesNotMatch(testOutput, /file-owned .* hook/)
          })
        }
      }
    })

    for (const [exclusiveFile, retainedFiles] of [
      ['top-level-it-exclusive.js', []],
      ['top-level-it-mixed-only.js', []],
      ['top-level-it-mixed-only.js', ['top-level-suite-retained-exclusive.js']],
    ]) {
      it(`cleans skipped exclusivity references for ${exclusiveFile} with ${retainedFiles.length} retained files`,
        async () => {
          const fixtureRoot = 'ci-visibility/mocha-plugin-tests/'
          const skippedFile = fixtureRoot + exclusiveFile
          receiver.setSettings({ itr_enabled: true, code_coverage: false, tests_skipping: true })
          receiver.setSuitesToSkip([{ type: 'suite', attributes: { suite: skippedFile } }])
          const files = [exclusiveFile, ...retainedFiles].map(file => fixtureRoot + file).join(' ')
          childProcess = exec(`node ./ci-visibility/run-mocha-tia-cleanup.js ${files}`, {
            cwd,
            env: getCiVisAgentlessConfig(receiver.port),
          })
          childProcess.stdout.on('data', chunk => { testOutput += chunk.toString() })
          childProcess.stderr.on('data', chunk => { testOutput += chunk.toString() })
          const eventsPromise = receiver.gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            payloads => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              assert.strictEqual(tests.length, retainedFiles.length, testOutput)
              assert.ok(tests.every(test => test.meta[TEST_STATUS] === 'pass'))
              const suite = events.find(event => event.type === 'test_suite_end' &&
                event.content.meta[TEST_SUITE] === skippedFile)?.content
              assert.ok(suite, testOutput)
              assert.strictEqual(suite.meta[TEST_STATUS], 'skip')
            }
          )
          const [[exitCode]] = await Promise.all([once(childProcess, 'close'), eventsPromise])
          assert.strictEqual(exitCode, 0, testOutput)
          assert.match(testOutput, /EXCLUSIVITY REFERENCES CLEANED/)
        })
    }

    describe('TIA skipping on reused Mocha instances', () => {
      // Reuse requires cleanReferencesAfterRun(false), unavailable on Mocha 5.2.
      const reuseIt = MOCHA_VERSION === 'latest' || satisfies(MOCHA_VERSION, '>=8.0.0') ? it : it.skip
      const fixtureRoot = 'ci-visibility/mocha-plugin-tests/'

      for (const mode of ['changed-skip-list', 'disabled-plugin']) {
        for (const hookType of ['before', 'after', 'beforeEach', 'afterEach', 'exclusive', 'exclusive-suite']) {
          reuseIt(`restores root tests and ${hookType} hooks for ${mode}`, async () => {
            const exclusive = hookType.startsWith('exclusive')
            const file = fixtureRoot + (hookType === 'exclusive-suite'
              ? 'top-level-suite-retained-exclusive.js'
              : exclusive ? 'top-level-it-reusable-exclusive.js' : 'top-level-it-skippable-hook.js')
            const retainedFile = fixtureRoot + 'top-level-it-mixed2.js'
            receiver.setSettings({ itr_enabled: true, code_coverage: false, tests_skipping: true })
            receiver.setSuitesToSkip([{ type: 'suite', attributes: { suite: file } }])

            childProcess = fork('./ci-visibility/run-mocha-tia-rerun.js', [file, retainedFile], {
              cwd,
              silent: true,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                MOCHA_TIA_RERUN_MODE: mode,
                ROOT_HOOK_TYPE: hookType,
                ROOT_HOOK_FAIL: 'false',
              },
            })
            childProcess.stdout.on('data', chunk => { testOutput += chunk.toString() })
            childProcess.stderr.on('data', chunk => { testOutput += chunk.toString() })
            const firstRunPromise = once(childProcess, 'message').then(([failures]) => {
              assert.strictEqual(failures, 0, testOutput)
              receiver.setSuitesToSkip([])
              childProcess.send('run again')
            })
            const eventsPromise = receiver.gatherPayloadsUntilChildExit(
              childProcess,
              ({ url }) => url.endsWith('/api/v2/citestcycle'),
              payloads => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                const tests = events.filter(event => event.type === 'test').map(event => event.content)
                const firstTests = exclusive ? 0 : 2
                const secondTests = exclusive ? 1 : 4
                const expectedTests = firstTests + (mode === 'changed-skip-list' ? secondTests : 0)
                assert.strictEqual(tests.length, expectedTests, testOutput)
                assert.ok(tests.every(test => test.meta[TEST_STATUS] === 'pass'), testOutput)
                const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
                const restoredSuites = suites.filter(suite => suite.meta[TEST_SUITE] === file)
                assert.deepStrictEqual(restoredSuites.map(suite => suite.meta[TEST_STATUS]),
                  mode === 'changed-skip-list' ? ['skip', 'pass'] : ['skip'], testOutput)
                for (const type of ['test_session_end', 'test_module_end']) {
                  const sessions = events.filter(event => event.type === type).map(event => event.content)
                  assert.strictEqual(sessions.length, mode === 'changed-skip-list' ? 2 : 1, testOutput)
                  assert.strictEqual(sessions[0].metrics[TEST_ITR_SKIPPING_COUNT], 1)
                  if (mode === 'changed-skip-list') {
                    assert.strictEqual(sessions[1].meta[TEST_STATUS], 'pass', testOutput)
                    assert.strictEqual(sessions[1].metrics[TEST_ITR_SKIPPING_COUNT], 0)
                  }
                }
              }
            )
            const [[exitCode]] = await Promise.all([once(childProcess, 'close'), eventsPromise, firstRunPromise])
            assert.strictEqual(exitCode, 0, testOutput)
            assert.match(testOutput, exclusive ? /1 passing/ : /4 passing/)
            assert.match(testOutput, /SECOND RUN FAILURES: 0/)
            if (exclusive) {
              if (hookType === 'exclusive') {
                for (const type of ['before', 'after', 'beforeEach', 'afterEach']) {
                  assert.strictEqual(testOutput.split(`exclusive ${type} hook`).length - 1, 1, testOutput)
                }
              }
            } else {
              const expectedHooks = hookType.endsWith('Each') ? 4 : 1
              assert.strictEqual(testOutput.split(`file-owned ${hookType} hook`).length - 1,
                expectedHooks, testOutput)
            }
          })
        }
      }
    })

    it('says TIA skipped all tests when grep excludes the remaining root-level test', async () => {
      const suiteFile = 'ci-visibility/mocha-plugin-tests/top-level-it-mixed.js'
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: false,
        tests_skipping: true,
      })
      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: { suite: suiteFile },
      }])

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test')
          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(tests.length, 0)
          assert.strictEqual(testSession.meta[TEST_STATUS], 'skip')
          assert.strictEqual(testSession.meta[TEST_SKIP_REASON], 'All tests were skipped')
          assert.strictEqual(testSession.meta[TEST_SESSION_EMPTY_REASON], 'all_tests_skipped')
        })

      childProcess = exec(
        `node node_modules/mocha/bin/mocha ./${suiteFile} --grep 'nested passing test'`,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })
      const [, [exitCode]] = await Promise.all([
        eventsPromise,
        once(childProcess, 'close'),
      ])
      assert.strictEqual(exitCode, 0)
      assert.strictEqual(
        testOutput.split(TEST_IMPACT_ANALYSIS_ALL_TESTS_SKIPPED_MESSAGE).length - 1,
        1,
        testOutput
      )
    })

    it('says TIA skipped all tests when it skips the exclusive suite', async () => {
      const suiteFile = 'ci-visibility/mocha-plugin-tests/top-level-it-mixed-only.js'
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: false,
        tests_skipping: true,
      })
      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: { suite: suiteFile },
      }])

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test')
          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(tests.length, 0)
          assert.strictEqual(testSession.meta[TEST_STATUS], 'skip')
        })

      childProcess = exec(
        `node node_modules/mocha/bin/mocha ./${suiteFile}`,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })
      const [, [exitCode]] = await Promise.all([
        eventsPromise,
        once(childProcess, 'close'),
      ])
      assert.strictEqual(exitCode, 0)
      assert.strictEqual(
        testOutput.split(TEST_IMPACT_ANALYSIS_ALL_TESTS_SKIPPED_MESSAGE).length - 1,
        1,
        testOutput
      )
    })

    for (const { name, grepArgument, expectedMessageCount } of [
      {
        name: 'says TIA skipped all tests in parallel mode without grep',
        grepArgument: '',
        expectedMessageCount: 1,
      },
      {
        name: 'does not say TIA skipped all tests in parallel mode when grep selects no tests',
        grepArgument: " --grep 'does not match'",
        expectedMessageCount: 0,
      },
    ]) {
      onlyLatestIt(name, async () => {
        const suiteFiles = [
          'ci-visibility/test/ci-visibility-test.js',
          'ci-visibility/test/ci-visibility-test-2.js',
        ]
        receiver.setSettings({
          itr_enabled: true,
          code_coverage: false,
          tests_skipping: true,
        })
        receiver.setSuitesToSkip(suiteFiles.map(suite => ({
          type: 'suite',
          attributes: { suite },
        })))

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test')
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(tests.length, 0)
            assert.strictEqual(testSession.meta[TEST_STATUS], 'skip')
            assert.strictEqual(testSession.meta[MOCHA_IS_PARALLEL], 'true')
          })

        childProcess = exec(
          'node node_modules/mocha/bin/mocha --parallel --jobs 2' +
          grepArgument +
          ` ./${suiteFiles[0]} ./${suiteFiles[1]}`,
          {
            cwd,
            env: getCiVisAgentlessConfig(receiver.port),
          }
        )
        childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
        childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })
        const [, [exitCode]] = await Promise.all([
          eventsPromise,
          once(childProcess, 'close'),
        ])
        assert.strictEqual(exitCode, 0, testOutput)
        assert.strictEqual(
          testOutput.split(TEST_IMPACT_ANALYSIS_ALL_TESTS_SKIPPED_MESSAGE).length - 1,
          expectedMessageCount,
          testOutput
        )
      })
    }

    it('does not skip tests if git metadata upload fails', (done) => {
      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: {
          suite: 'ci-visibility/test/ci-visibility-test.js',
        },
      }])

      receiver.setGitUploadStatus(404)

      receiver.assertPayloadReceived(() => {
        const error = new Error('should not request skippable')
        done(error)
      }, ({ url }) => url === '/api/v2/ci/tests/skippable').catch(() => {})

      receiver.assertPayloadReceived(({ headers, payload }) => {
        assert.strictEqual(headers['dd-api-key'], '1')
        const eventTypes = payload.events.map(event => event.type)
        // because they are not skipped
        assertObjectContains(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
        const numSuites = eventTypes.reduce(
          (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
        )
        assert.strictEqual(numSuites, 2)
        const testSession = payload.events.find(event => event.type === 'test_session_end').content
        assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'false')
        assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
        assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
        const testModule = payload.events.find(event => event.type === 'test_module_end').content
        assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'false')
        assert.strictEqual(testModule.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
        assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
        assertItrSkippingEnabledTags(payload.events, 'true')
      }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )
    })

    it('does not skip tests if test skipping is disabled by the API', (done) => {
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: true,
        tests_skipping: false,
      })

      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: {
          suite: 'ci-visibility/test/ci-visibility-test.js',
        },
      }])

      receiver.assertPayloadReceived(() => {
        const error = new Error('should not request skippable')
        done(error)
      }, ({ url }) => url === '/api/v2/ci/tests/skippable').catch(() => {})

      receiver.assertPayloadReceived(({ headers, payload }) => {
        assert.strictEqual(headers['dd-api-key'], '1')
        const eventTypes = payload.events.map(event => event.type)
        // because they are not skipped
        assertObjectContains(eventTypes, ['test', 'test_session_end', 'test_module_end', 'test_suite_end'])
        const numSuites = eventTypes.reduce(
          (acc, type) => type === 'test_suite_end' ? acc + 1 : acc, 0
        )
        assert.strictEqual(numSuites, 2)
      }, ({ url }) => url === '/api/v2/citestcycle').then(() => done()).catch(done)

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )
    })

    it('does not skip suites if suite is marked as unskippable', async () => {
      const coveredSkippedLines = getLinesBitmapBase64(1, 20)
      receiver.setSuitesToSkip([
        {
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/unskippable-test/test-to-skip.js',
          },
        },
        {
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/unskippable-test/test-unskippable.js',
          },
        },
      ])
      receiver.setSkippableCoverage({
        'ci-visibility/unskippable-test/test-to-skip.js': coveredSkippedLines,
        'ci-visibility/unskippable-test/test-unskippable.js': coveredSkippedLines,
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const suites = events.filter(event => event.type === 'test_suite_end')

          assert.strictEqual(suites.length, 3)

          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content
          assert.strictEqual(testSession.meta[TEST_ITR_FORCED_RUN], 'true')
          assert.strictEqual(testSession.meta[TEST_ITR_UNSKIPPABLE], 'true')
          assert.strictEqual(testModule.meta[TEST_ITR_FORCED_RUN], 'true')
          assert.strictEqual(testModule.meta[TEST_ITR_UNSKIPPABLE], 'true')

          const passedSuite = suites.find(
            event => event.content.resource === 'test_suite.ci-visibility/unskippable-test/test-to-run.js'
          )
          const skippedSuite = suites.find(
            event => event.content.resource === 'test_suite.ci-visibility/unskippable-test/test-to-skip.js'
          )
          const forcedToRunSuite = suites.find(
            event => event.content.resource === 'test_suite.ci-visibility/unskippable-test/test-unskippable.js'
          )
          // It does not mark as unskippable if there is no docblock
          assert.strictEqual(passedSuite.content.meta[TEST_STATUS], 'pass')
          assert.ok(!(TEST_ITR_UNSKIPPABLE in passedSuite.content.meta))
          assert.ok(!(TEST_ITR_FORCED_RUN in passedSuite.content.meta))

          assert.strictEqual(skippedSuite.content.meta[TEST_STATUS], 'skip')
          assert.ok(!(TEST_ITR_UNSKIPPABLE in skippedSuite.content.meta))
          assert.ok(!(TEST_ITR_FORCED_RUN in skippedSuite.content.meta))

          assert.strictEqual(forcedToRunSuite.content.meta[TEST_STATUS], 'pass')
          assert.strictEqual(forcedToRunSuite.content.meta[TEST_ITR_UNSKIPPABLE], 'true')
          assert.strictEqual(forcedToRunSuite.content.meta[TEST_ITR_FORCED_RUN], 'true')
        }, 25000)

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './unskippable-test/test-to-run.js',
              './unskippable-test/test-to-skip.js',
              './unskippable-test/test-unskippable.js',
            ]),
          },
        }
      )

      const [, [exitCode]] = await Promise.all([
        eventsPromise,
        once(childProcess, 'exit'),
      ])
      assert.strictEqual(exitCode, 0)
    })

    it('only sets forced to run if suite was going to be skipped by ITR', async () => {
      receiver.setSuitesToSkip([
        {
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/unskippable-test/test-to-skip.js',
          },
        },
      ])
      receiver.setSkippableCoverage({
        'ci-visibility/unskippable-test/test-to-skip.js': getLinesBitmapBase64(1, 20),
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const suites = events.filter(event => event.type === 'test_suite_end')

          assert.strictEqual(suites.length, 3)

          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content
          assert.ok(!(TEST_ITR_FORCED_RUN in testSession.meta))
          assert.strictEqual(testSession.meta[TEST_ITR_UNSKIPPABLE], 'true')
          assert.ok(!(TEST_ITR_FORCED_RUN in testModule.meta))
          assert.strictEqual(testModule.meta[TEST_ITR_UNSKIPPABLE], 'true')

          const passedSuite = suites.find(
            event => event.content.resource === 'test_suite.ci-visibility/unskippable-test/test-to-run.js'
          )
          const skippedSuite = suites.find(
            event => event.content.resource === 'test_suite.ci-visibility/unskippable-test/test-to-skip.js'
          ).content
          const nonSkippedSuite = suites.find(
            event => event.content.resource === 'test_suite.ci-visibility/unskippable-test/test-unskippable.js'
          ).content

          // It does not mark as unskippable if there is no docblock
          assert.strictEqual(passedSuite.content.meta[TEST_STATUS], 'pass')
          assert.ok(!(TEST_ITR_UNSKIPPABLE in passedSuite.content.meta))
          assert.ok(!(TEST_ITR_FORCED_RUN in passedSuite.content.meta))

          assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')

          assert.strictEqual(nonSkippedSuite.meta[TEST_STATUS], 'pass')
          assert.strictEqual(nonSkippedSuite.meta[TEST_ITR_UNSKIPPABLE], 'true')
          // it was not forced to run because it wasn't going to be skipped
          assert.ok(!(TEST_ITR_FORCED_RUN in nonSkippedSuite.meta))
        }, 25000)

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: JSON.stringify([
              './unskippable-test/test-to-run.js',
              './unskippable-test/test-to-skip.js',
              './unskippable-test/test-unskippable.js',
            ]),
          },
        }
      )

      const [, [exitCode]] = await Promise.all([
        eventsPromise,
        once(childProcess, 'exit'),
      ])
      assert.strictEqual(exitCode, 0)
    })

    it('sets _dd.ci.itr.tests_skipped to false if the received suite is not skipped', (done) => {
      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: {
          suite: 'ci-visibility/test/not-existing-test.js',
        },
      }])
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'false')
          assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
          assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
          const testModule = events.find(event => event.type === 'test_module_end').content
          assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'false')
          assert.strictEqual(testModule.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
          assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
          assertItrSkippingEnabledTags(events, 'true')
        }, 25000)

      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('reports itr_correlation_id in test suites', (done) => {
      const itrCorrelationId = '4321'
      receiver.setItrCorrelationId(itrCorrelationId)
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSuites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
          testSuites.forEach(testSuite => {
            assert.strictEqual(testSuite.itr_correlation_id, itrCorrelationId)
          })
        }, 25000)
      childProcess = exec(
        runTestsWithCoverageCommand,
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )
      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    it('reports code coverage relative to the repository root, not working directory', (done) => {
      receiver.setSettings({
        itr_enabled: true,
        code_coverage: true,
        tests_skipping: false,
      })

      const codeCoveragesPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcov'), (payloads) => {
          const coveredFiles = payloads
            .flatMap(({ payload }) => payload)
            .flatMap(({ content: { coverages } }) => coverages)
            .flatMap(({ files }) => files)
            .map(({ filename }) => filename)

          assertObjectContains(coveredFiles, [
            'ci-visibility/subproject/dependency.js',
            'ci-visibility/subproject/subproject-test.js',
          ])
        }, 5000)

      childProcess = exec(
        '../../node_modules/nyc/bin/nyc.js node ../../node_modules/mocha/bin/mocha subproject-test.js',
        {
          cwd: `${cwd}/ci-visibility/subproject`,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
          },
        }
      )

      childProcess.on('exit', () => {
        codeCoveragesPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    onlyLatestIt('can skip suites in parallel mode', async () => {
      receiver.setSuitesToSkip([{
        type: 'suite',
        attributes: {
          suite: 'ci-visibility/test/ci-visibility-test.js',
        },
      }])
      receiver.setSkippableCoverage({
        'ci-visibility/test/ci-visibility-test.js': getLinesBitmapBase64(1, 20),
      })

      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[MOCHA_IS_PARALLEL], 'true')
          assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
          assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'true')
          assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_TYPE], 'suite')
          assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 1)

          const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
          assert.strictEqual(suites.length, 2)

          const skippedSuite = suites.find(s =>
            s.resource === 'test_suite.ci-visibility/test/ci-visibility-test.js'
          )
          assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
          assert.strictEqual(skippedSuite.meta[TEST_SKIPPED_BY_ITR], 'true')

          const runningSuite = suites.find(s =>
            s.resource === 'test_suite.ci-visibility/test/ci-visibility-test-2.js'
          )
          assert.strictEqual(runningSuite.meta[TEST_STATUS], 'pass')

          // Only 1 test ran (from the non-skipped suite)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.strictEqual(tests.length, 1)
          assert.strictEqual(tests[0].meta[TEST_STATUS], 'pass')
          assertItrSkippingEnabledTags(events, 'true')
        })

      childProcess = exec(
        'node node_modules/mocha/bin/mocha --parallel --jobs 2' +
        ' ./ci-visibility/test/ci-visibility-test.js' +
        ' ./ci-visibility/test/ci-visibility-test-2.js',
        {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        }
      )

      await Promise.all([
        eventsPromise,
        once(childProcess, 'exit'),
      ])
    })
  })

  context('error tags', () => {
    it(
      'tags session and children with _dd.ci.library_configuration_error.settings when settings fails 4xx',
      async () => {
        receiver.setSettingsResponseCode(404)
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
            const testModule = events.find(event => event.type === 'test_module_end')
            assert.ok(testModule, 'should have test module event')
            assert.strictEqual(testModule.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
            const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
            assert.ok(testSuiteEvent, 'should have test suite event')
            assert.strictEqual(testSuiteEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
            const testEvent = events.find(event => event.type === 'test')
            assert.ok(testEvent, 'should have test event')
            assert.strictEqual(testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS], 'true')
          })
        childProcess = exec(runTestsCommand, {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        })
        await Promise.all([eventsPromise, once(childProcess, 'exit')])
      })

    it(
      'tags session and children with _dd.ci.library_configuration_error.skippable_tests when request fails 4xx',
      async () => {
        receiver.setSkippableSuitesResponseCode(404)
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS], 'true')
            const testModule = events.find(event => event.type === 'test_module_end')
            assert.ok(testModule, 'should have test module event')
            assert.strictEqual(testModule.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS], 'true')
            const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
            assert.ok(testSuiteEvent, 'should have test suite event')
            assert.strictEqual(testSuiteEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS], 'true')
            const testEvent = events.find(event => event.type === 'test')
            assert.ok(testEvent, 'should have test event')
            assert.strictEqual(testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS], 'true')
          })
        childProcess = exec(runTestsCommand, {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        })
        await Promise.all([eventsPromise, once(childProcess, 'exit')])
      })

    it(
      'tags session and children with _dd.ci.library_configuration_error.known_tests when request fails 4xx',
      async () => {
        receiver.setSettings({ known_tests_enabled: true })
        receiver.setKnownTestsResponseCode(404)
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
            const testModule = events.find(event => event.type === 'test_module_end')
            assert.ok(testModule, 'should have test module event')
            assert.strictEqual(testModule.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
            const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
            assert.ok(testSuiteEvent, 'should have test suite event')
            assert.strictEqual(testSuiteEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
            const testEvent = events.find(event => event.type === 'test')
            assert.ok(testEvent, 'should have test event')
            assert.strictEqual(testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS], 'true')
          })
        childProcess = exec(runTestsCommand, {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        })
        await Promise.all([eventsPromise, once(childProcess, 'exit')])
      })

    it(
      'tags session and children with _dd.ci.library_configuration_error.test_management_tests when request fails',
      async () => {
        receiver.setSettings({ test_management: { enabled: true } })
        receiver.setTestManagementTestsResponseCode(404)
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true')
            const testModule = events.find(event => event.type === 'test_module_end')
            assert.ok(testModule, 'should have test module event')
            assert.strictEqual(
              testModule.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true'
            )
            const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
            assert.ok(testSuiteEvent, 'should have test suite event')
            assert.strictEqual(
              testSuiteEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true'
            )
            const testEvent = events.find(event => event.type === 'test')
            assert.ok(testEvent, 'should have test event')
            assert.strictEqual(testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS], 'true')
          })
        childProcess = exec(runTestsCommand, {
          cwd,
          env: getCiVisAgentlessConfig(receiver.port),
        })
        await Promise.all([eventsPromise, once(childProcess, 'exit')])
      })
  })

  context('test automation exclusions', () => {
    const runReviewFixture = async (file, expectedExit, check, env = {}, command) => {
      childProcess = exec(command || `node node_modules/mocha/bin/mocha ci-visibility/test-management/${file}.js`, {
        cwd,
        env: { ...getCiVisAgentlessConfig(receiver.port), DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '2', ...env },
      })
      childProcess.stdout.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr.on('data', chunk => { testOutput += chunk.toString() })
      const eventsPromise = receiver.gatherPayloadsUntilChildExit(childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          check(payloads.flatMap(({ payload }) => payload.events))
        })
      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise]).catch(error => {
        error.message += `\nMocha output:\n${testOutput}`
        throw error
      })
      assert.strictEqual(exitCode, expectedExit, testOutput)
    }

    parallelIt('clears annotation observations between parallel runs', async () => {
      receiver.setSettings({ test_management: { enabled: true } })
      receiver.setTestManagementTests({
        mocha: {
          suites: {
            'ci-visibility/test-management/mocha-review-repeated.js': {
              tests: { 'same test': { properties: { quarantined: true } } },
            },
          },
        },
      })
      await runReviewFixture('mocha-review-repeated', 0, events => {
        const tests = events.filter(event => event.type === 'test').map(event => event.content)
        assert.strictEqual(tests.length, 2)
        assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]), ['pass', 'fail'])
        assert.strictEqual(tests[0].meta['test.test_management.prevent_failure_suppression'], 'true')
        assert.strictEqual(tests[1].meta['test.test_management.prevent_failure_suppression'], undefined)
        assert.match(testOutput, /failures: 0,0/)
      }, {}, 'node ci-visibility/run-mocha-review-repeated.js')
    })

    parallelIt('preserves per-execution protection for duplicate parallel titles', async () => {
      receiver.setSettings({ test_management: { enabled: true } })
      receiver.setTestManagementTests({
        mocha: {
          suites: {
            'ci-visibility/test-management/mocha-review-duplicates.js': {
              tests: { duplicate: { properties: { quarantined: true } } },
            },
          },
        },
      })
      await runReviewFixture('mocha-review-duplicates', 1, events => {
        const tests = events.filter(event => event.type === 'test').map(event => event.content)
        assert.strictEqual(tests.length, 3)
        assert.strictEqual(tests.find(test => test.meta['test.test_management.prevent_failure_suppression'] === 'true')
          .meta['test.test_management.prevent_failure_suppression'], 'true')
        assert.strictEqual(tests.find(test => test.meta[TEST_STATUS] === 'pass')
          .meta['test.test_management.no_auto_retry'], 'true')
      }, {}, 'node node_modules/mocha/bin/mocha --parallel --jobs 2' +
        ' ci-visibility/test-management/mocha-review-duplicates.js')
    })

    it('preserves suite-only mocha-each declarations with the TDD interface', async () => {
      await runReviewFixture('mocha-review-suite-only', 0, events => {
        const tests = events.filter(event => event.type === 'test').map(event => event.content)
        assert.strictEqual(tests.length, 2)
        assert.deepStrictEqual(tests.map(test => test.meta[TEST_NAME]).sort(), ['row 1 passes', 'row 2 passes'])
        for (const test of tests) assert.strictEqual(test.meta[TEST_STATUS], 'pass')
      }, {}, 'node node_modules/mocha/bin/mocha --ui tdd' +
        ' ci-visibility/test-management/mocha-review-suite-only.js')
    })

    for (const parallel of [false, true]) {
      const run = parallel ? parallelIt : it
      run(`preserves annotated TDD skip declarations (parallel=${parallel})`, async () => {
        receiver.setSettings({ test_management: { enabled: true } })
        await runReviewFixture('mocha-review-tdd-skips', 0, events => {
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.strictEqual(tests.length, 6)
          for (const test of tests) {
            const name = test.meta[TEST_NAME].replace('TDD skips ', '')
            assert.strictEqual(test.meta[TEST_STATUS], name === 'live control' ? 'pass' : 'skip', name)
            assert.strictEqual(test.meta['test.test_management.prevent_failure_suppression'],
              ['combined', 'protected'].includes(name) ? 'true' : undefined, name)
            assert.strictEqual(test.meta['test.test_management.no_auto_retry'],
              ['combined', 'no retry'].includes(name) ? 'true' : undefined, name)
          }
        }, {}, `node node_modules/mocha/bin/mocha --ui tdd ${parallel ? '--parallel --jobs 2' : ''}` +
          ' ci-visibility/test-management/mocha-review-tdd-skips.js')
      })
    }

    it('finishes exactly one span per runtime and declaration skip', async () => {
      receiver.setSettings({ test_management: { enabled: true } })
      await runReviewFixture('mocha-review-runtime-skips', 0, events => {
        const tests = events.filter(event => event.type === 'test').map(event => event.content)
        assert.strictEqual(tests.length, 4)
        for (const test of tests) {
          const skipped = test.meta[TEST_NAME] !== 'live control'
          assert.strictEqual(test.meta[TEST_STATUS], skipped ? 'skip' : 'pass')
          assert.strictEqual(test.meta[TEST_FINAL_STATUS], skipped ? 'skip' : 'pass')
          assert.strictEqual(test.meta['test.test_management.prevent_failure_suppression'],
            skipped ? 'true' : undefined)
          assert.strictEqual(test.meta['test.test_management.no_auto_retry'], skipped ? 'true' : undefined)
        }
      })
    })

    it('preserves annotations on exported skipped declarations', async () => {
      receiver.setSettings({ test_management: { enabled: true } })
      await runReviewFixture('mocha-review-exported', 0, events => {
        const tests = events.filter(event => event.type === 'test').map(event => event.content)
        assert.strictEqual(tests.length, 4)
        for (const test of tests) {
          const skipped = test.meta[TEST_NAME] !== 'live control'
          assert.strictEqual(test.meta[TEST_STATUS], skipped ? 'skip' : 'pass')
          assert.strictEqual(test.meta['test.test_management.prevent_failure_suppression'],
            skipped ? 'true' : undefined)
          assert.strictEqual(test.meta['test.test_management.no_auto_retry'], skipped ? 'true' : undefined)
        }
      })
    })

    for (const parallel of [false, true]) {
      for (const only of [false, true]) {
        // Mocha rejects exclusive suites when parallel mode is enabled.
        const run = parallel && only ? it.skip : parallel ? parallelIt : it
        run(`preserves mocha-each declaration annotations (parallel=${parallel}, only=${only})`, async () => {
          // Mocha 6 stopped treating every empty-titled suite as a root suite.
          const namePrefix = only && mochaMajor >= 6 ? ' ' : ''
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            test_management: { enabled: true, attempt_to_fix_retries: 2 },
          })
          receiver.setTestManagementTests({
            mocha: {
              suites: {
                'ci-visibility/test-management/mocha-review-each.js': {
                  tests: Object.fromEntries(['case 1', 'case 2', 'passing 3'].map(name => [`${namePrefix}${name}`, {
                    properties: { disabled: true, quarantined: true, attempt_to_fix: true },
                  }])),
                },
              },
            },
          })
          await runReviewFixture('mocha-review-each', 2, events => {
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 4, testOutput)
            for (const test of tests) {
              const name = test.meta[TEST_NAME].trim()
              assert.strictEqual(test.meta[TEST_STATUS],
                name.startsWith('case') ? 'fail' : name.startsWith('passing') ? 'pass' : 'skip', name)
              assert.strictEqual(test.meta['test.test_management.prevent_failure_suppression'], 'true', name)
              assert.strictEqual(test.meta['test.test_management.no_auto_retry'], 'true', name)
              if (!name.startsWith('skipped')) {
                assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_DISABLED], 'true', name)
                assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true', name)
                assert.strictEqual(test.meta[TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX], 'true', name)
              }
            }
          }, { MOCHA_REVIEW_ONLY: only ? '1' : '0' },
          `node node_modules/mocha/bin/mocha ${parallel ? '--parallel --jobs 2' : ''}` +
            ' ci-visibility/test-management/mocha-review-each.js')
        })
      }
    }

    for (const parallel of [false, true]) {
      for (const scenario of [
        {
          name: 'combined annotations',
          protect: true,
          noRetry: true,
          properties: {
            attempt_to_fix: true, disabled: true, quarantined: true,
          },
          count: 1,
          exit: 1,
          status: 'fail',
        },
        {
          name: 'retry exclusion retains quarantine',
          noRetry: true,
          properties: {
            attempt_to_fix: true, quarantined: true,
          },
          count: 1,
          exit: 0,
          status: 'fail',
        },
        {
          name: 'retry exclusion retains disabling',
          noRetry: true,
          properties: {
            attempt_to_fix: true, disabled: true,
          },
          count: 1,
          exit: 0,
          status: 'skip',
        },
        {
          name: 'protection permits ATR',
          needsRetryEvents: true,
          protect: true,
          properties: { quarantined: true },
          count: 3,
          exit: 1,
          status: 'fail',
        },
        {
          name: 'explicit retries remain',
          needsRetryEvents: true,
          noRetry: true,
          native: true,
          properties: {},
          count: 3,
          exit: 1,
          status: 'fail',
        },
        {
          name: 'retry exclusion prevents EFD',
          noRetry: true,
          efd: true,
          properties: {},
          count: 1,
          exit: 1,
          status: 'fail',
        },
        {
          name: 'passing protection stays passing',
          protect: true,
          noRetry: true,
          pass: true,
          properties: { disabled: true },
          count: 1,
          exit: 0,
          status: 'pass',
        },
      ]) {
        const run = scenario.needsRetryEvents && !supportsMochaRetryEvents
          ? it.skip
          : parallel ? parallelIt : it
        run(`${scenario.name} in ${parallel ? 'parallel' : 'serial'} mode`, async () => {
          receiver.setKnownTests({ mocha: {} })
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            known_tests_enabled: scenario.efd === true,
            early_flake_detection: { enabled: scenario.efd === true, slow_test_retries: { '5s': 2 } },
            test_management: {
              enabled: true, attempt_to_fix_retries: 2,
            },
          })
          receiver.setTestManagementTests({
            mocha: {
              suites: {
                'ci-visibility/test-management/test-exclusions-mocha.js': {
                  tests: {
                    'annotated test': { properties: scenario.properties },
                  },
                },
              },
            },
          })
          childProcess = exec(
            `node node_modules/mocha/bin/mocha ${parallel ? '--parallel --jobs 2' : ''}` +
            ` ${scenario.native ? '--retries 2' : ''}` +
            ' ci-visibility/test-management/test-exclusions-mocha.js', {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '2',
                EXCLUSION_PROTECT: scenario.protect ? '1' : '0',
                EXCLUSION_NO_RETRY: scenario.noRetry ? '1' : '0',
                EXCLUSION_PASS: scenario.pass ? '1' : '0',
              },
            })
          childProcess.stdout.on('data', chunk => { testOutput += chunk.toString() })
          childProcess.stderr.on('data', chunk => { testOutput += chunk.toString() })
          const eventsPromise = receiver.gatherPayloadsUntilChildExit(childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const tests = payloads.flatMap(({ payload }) => payload.events)
                .filter(event => event.type === 'test').map(event => event.content)
              const attempts = tests.filter(test => test.meta[TEST_NAME] === 'annotated test')
              assert.strictEqual(attempts.length, scenario.count, testOutput)
              for (const test of attempts) {
                assert.strictEqual(test.meta[TEST_STATUS], scenario.status)
                assert.strictEqual(test.meta['test.test_management.prevent_failure_suppression'],
                  scenario.protect ? 'true' : undefined)
                assert.strictEqual(test.meta['test.test_management.no_auto_retry'],
                  scenario.noRetry ? 'true' : undefined)
                for (const [property, tag] of [
                  ['attempt_to_fix', TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX],
                  ['disabled', TEST_MANAGEMENT_IS_DISABLED],
                  ['quarantined', TEST_MANAGEMENT_IS_QUARANTINED],
                ]) assert.strictEqual(test.meta[tag], scenario.properties[property] ? 'true' : undefined)
                if (scenario.noRetry) {
                  assert.strictEqual(test.meta[TEST_RETRY_REASON],
                    scenario.native && test.meta[TEST_IS_RETRY] ? TEST_RETRY_REASON_TYPES.ext : undefined)
                  assert.strictEqual(test.meta[TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED], undefined)
                }
              }
              const skipped = tests.find(test => test.meta[TEST_NAME] === 'developer skip')
              assert.strictEqual(skipped.meta[TEST_STATUS], 'skip')
              assert.strictEqual(skipped.meta['test.test_management.no_auto_retry'], 'true', testOutput)
              assert.strictEqual(skipped.meta['test.test_management.prevent_failure_suppression'], 'true')
            })
          const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
          assert.strictEqual(exitCode, scenario.exit, testOutput)
        })
      }
    }
  })

})
