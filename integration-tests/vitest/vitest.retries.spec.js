'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { inspect } = require('node:util')
const { assertObjectContains } = require('../helpers')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  ERROR_MESSAGE,
  ERROR_STACK,
  ERROR_TYPE,
} = require('../../packages/dd-trace/src/constants')
const {
  TEST_STATUS,
  TEST_IS_RETRY,
  TEST_IS_NEW,
  TEST_NAME,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_SUITE,
  DI_ERROR_DEBUG_INFO_CAPTURED,
  DI_DEBUG_ERROR_PREFIX,
  DI_DEBUG_ERROR_FILE_SUFFIX,
  DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX,
  DI_DEBUG_ERROR_LINE_SUFFIX,
  TEST_RETRY_REASON,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_RETRY_REASON_TYPES,
  TEST_HAS_DYNAMIC_NAME,
  TEST_FINAL_STATUS,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { NODE_MAJOR } = require('../../version')

const NUM_RETRIES_EFD = 3
const CUSTOM_SEQUENCER_MARKER = 'dd-trace custom vitest sequencer was used'
const FLAKY_EVENTUALLY_PASSING_RESOURCE =
  'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass'
const FLAKY_NEVER_PASSING_RESOURCE =
  'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass'
const FLAKY_UNNECESSARY_RETRY_RESOURCE =
  'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries does not retry if unnecessary'

// vitest@4.x requires Node.js >= 20
const supportedVersions = NODE_MAJOR <= 18 ? ['1.6.0', '3.2.6'] : ['1.6.0', 'latest']
const requestedVersion = process.env.VITEST_VERSION
const versions = requestedVersion && requestedVersion !== 'all'
  ? [requestedVersion === 'oldest'
      ? supportedVersions[0]
      : requestedVersion === 'latest' ? supportedVersions.at(-1) : requestedVersion]
  : supportedVersions
const runVersionIndependentSuites = !requestedVersion || requestedVersion === 'all' || requestedVersion === 'latest'

versions.forEach((version) => {
  describe(`vitest@${version}`, () => {
    let cwd, receiver, childProcess, testOutput
    const newerVitestIt = version === '1.6.0' ? it.skip : it
    // Native module loading was introduced in Vitest 4.1; Vitest 5 requires Node.js >=22.
    const nativeModuleRunnerIt = version === 'latest' && NODE_MAJOR >= 22 ? it : it.skip
    const runtimeEfdSuiteAdmissionIt = version === 'latest' && NODE_MAJOR >= 20 ? it : it.skip

    useSandbox([
      `vitest@${version}`,
      // Vite 8.3.5's source-map parser rejects the Buffers returned by Vitest's server runner.
      // TODO: remove the pin once Vitest reads cached server modules as UTF-8.
      ...(version === 'latest' ? ['vite@8.3.4'] : []),
      `@vitest/coverage-istanbul@${version}`,
      `@vitest/coverage-v8@${version}`,
      '@types/node',
      'tinypool',
      'typescript@6.0.3',
    ], true)

    before(function () {
      cwd = sandboxCwd()
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      testOutput = ''
      childProcess.kill()
      await receiver.stop()
    })

    context('flaky test retries', () => {
      it('can retry flaky tests', (done) => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false,
          },
        })

        const eventsPromise = receiver.gatherPayloadsMaxTimeout(
          ({ url }) => url === '/api/v2/citestcycle',
          payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testEvents = events.filter(event => event.type === 'test')
            assert.strictEqual(testEvents.length, 11)
            assertObjectContains(testEvents.map(test => test.content.resource), [
              FLAKY_EVENTUALLY_PASSING_RESOURCE,
              FLAKY_EVENTUALLY_PASSING_RESOURCE,
              FLAKY_EVENTUALLY_PASSING_RESOURCE,
              // passes at the third retry
              FLAKY_NEVER_PASSING_RESOURCE,
              FLAKY_NEVER_PASSING_RESOURCE,
              FLAKY_NEVER_PASSING_RESOURCE,
              FLAKY_NEVER_PASSING_RESOURCE,
              FLAKY_NEVER_PASSING_RESOURCE,
              FLAKY_EVENTUALLY_PASSING_RESOURCE,
              // never passes
              FLAKY_NEVER_PASSING_RESOURCE,
              // passes on the first try
              FLAKY_UNNECESSARY_RETRY_RESOURCE,
            ])
            const eventuallyPassingTest = testEvents.filter(
              test => test.content.resource === FLAKY_EVENTUALLY_PASSING_RESOURCE
            )
            assert.strictEqual(eventuallyPassingTest.length, 4)
            assert.strictEqual(
              eventuallyPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'fail').length,
              3
            )
            assert.strictEqual(
              eventuallyPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'pass').length,
              1
            )
            assert.strictEqual(
              eventuallyPassingTest.filter(test => test.content.meta[TEST_IS_RETRY] === 'true').length,
              3
            )
            assert.strictEqual(eventuallyPassingTest.filter(test =>
              test.content.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
            ).length, 3)

            const neverPassingTest = testEvents.filter(
              test => test.content.resource === FLAKY_NEVER_PASSING_RESOURCE
            )
            assert.strictEqual(neverPassingTest.length, 6)
            assert.strictEqual(neverPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'fail').length, 6)
            assert.strictEqual(neverPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'pass').length, 0)
            assert.strictEqual(neverPassingTest.filter(test => test.content.meta[TEST_IS_RETRY] === 'true').length, 5)
            assert.strictEqual(neverPassingTest.filter(test =>
              test.content.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
            ).length, 5)
          }
        )

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/flaky-test-retries*',
              CUSTOM_SEQUENCER: version === '1.6.0' ? undefined : 'true',
              CUSTOM_SEQUENCER_MARKER: version === '1.6.0' ? undefined : CUSTOM_SEQUENCER_MARKER,
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
            },
          }
        )
        let childStdout = ''
        childProcess.stdout?.on('data', chunk => { childStdout += chunk.toString() })

        Promise.all([eventsPromise, once(childProcess, 'exit')]).then(() => {
          if (version !== '1.6.0') {
            assert.ok(childStdout.includes(CUSTOM_SEQUENCER_MARKER), `Got: ${inspect(childStdout)}`)
          }
          done()
        }).catch(done)
      })

      it('uses the cached dynamic budget when supported and the flat count otherwise', (done) => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          flaky_test_retries_count: 0,
          early_flake_detection: { enabled: false },
        })

        const eventsPromise = receiver.gatherPayloadsMaxTimeout(
          ({ url }) => url === '/api/v2/citestcycle',
          payloads => {
            const tests = payloads.flatMap(({ payload }) => payload.events)
              .filter(event => event.type === 'test').map(event => event.content)
            const neverPassingTest = tests.filter(test => test.resource === FLAKY_NEVER_PASSING_RESOURCE)
            assert.strictEqual(neverPassingTest.length, version === 'latest' ? 2 : 6)
            assert.ok(neverPassingTest.every(test => test.meta[TEST_STATUS] === 'fail'))
          }
        )

        childProcess = exec('./node_modules/.bin/vitest run', {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TEST_DIR: 'ci-visibility/vitest-tests/flaky-test-retries*',
            DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED: 'true',
            DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: '1,2,3,4,5',
            DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '5',
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
          },
        })

        Promise.all([eventsPromise, once(childProcess, 'exit')]).then(() => done(), done)
      })

      it('is disabled if DD_CIVISIBILITY_FLAKY_RETRY_ENABLED is false', (done) => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false,
          },
        })

        receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testEvents = events.filter(event => event.type === 'test')
          assert.strictEqual(testEvents.length, 3)
          assertObjectContains(testEvents.map(test => test.content.resource), [
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries does not retry if unnecessary',
          ])
          assert.strictEqual(testEvents.filter(
            test => test.content.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          ).length, 0)
        }).then(() => done()).catch(done)

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/flaky-test-retries*',
              DD_CIVISIBILITY_FLAKY_RETRY_ENABLED: 'false',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
            },
          }
        )
      })

      it('retries DD_CIVISIBILITY_FLAKY_RETRY_COUNT times', (done) => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false,
          },
        })

        receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testEvents = events.filter(event => event.type === 'test')
          assert.strictEqual(testEvents.length, 5)
          assertObjectContains(testEvents.map(test => test.content.resource), [
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries does not retry if unnecessary',
          ])
          assert.strictEqual(testEvents.filter(
            test => test.content.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.atr
          ).length, 2)
        }).then(() => done()).catch(done)

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/flaky-test-retries*',
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '1',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
            },
          }
        )
      })

      it('sets TEST_HAS_FAILED_ALL_RETRIES when all ATR attempts fail', async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          flaky_test_retries_count: 2,
          early_flake_detection: {
            enabled: false,
          },
        })

        const eventsPromise = receiver.gatherPayloadsMaxTimeout(
          ({ url }) => url === '/api/v2/citestcycle',
          payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const neverPassingTest = tests.filter(
              test => test.resource ===
                'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass'
            )
            assert.strictEqual(neverPassingTest.length, 3, '1 initial + 2 ATR retries')
            neverPassingTest.forEach(t => assert.strictEqual(t.meta[TEST_STATUS], 'fail'))

            const lastAttempt = neverPassingTest[neverPassingTest.length - 1]
            assert.strictEqual(lastAttempt.meta[TEST_HAS_FAILED_ALL_RETRIES], 'true')

            for (let i = 0; i < neverPassingTest.length - 1; i++) {
              assert.ok(!(TEST_HAS_FAILED_ALL_RETRIES in neverPassingTest[i].meta))
            }
          }
        )

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/flaky-test-retries*',
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '2',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )

        await Promise.all([once(childProcess, 'exit'), eventsPromise])
      })
    })

    context('early flake detection', () => {
      it('retries new tests', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection can retry tests that eventually fail', // will be considered new
              // 'early flake detection can retry tests that pass only on the last attempt', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // skipped so not retried
              'early flake detection does not retry if it is not new',
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 18)

            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that eventually fail',
              'early flake detection can retry tests that eventually fail',
              'early flake detection can retry tests that eventually fail',
              'early flake detection can retry tests that pass only on the last attempt',
              'early flake detection can retry tests that pass only on the last attempt',
              'early flake detection can retry tests that pass only on the last attempt',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
              'early flake detection can retry tests that eventually fail',
              'early flake detection can retry tests that pass only on the last attempt',
            ])
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            // 4 executions of the 4 new tests + 1 new skipped test (not retried)
            assert.strictEqual(newTests.length, 17)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 12) // 3 retries of the 4 new tests

            retriedTests.forEach(test => {
              assert.strictEqual(test.meta[TEST_RETRY_REASON], TEST_RETRY_REASON_TYPES.efd)
            })

            // exit code should be 0 and test session should be reported as passed,
            // even though there are some failing executions
            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 6)

            // Verifies that task.result.state is reset before the last repetition runs.
            // Without this reset, vitest keeps a stale 'fail' from prior repetitions and
            // incorrectly reports the last execution as failed even when it succeeds.
            const lastAttemptPassTests = tests
              .filter(test =>
                test.meta[TEST_NAME] === 'early flake detection can retry tests that pass only on the last attempt')
              .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
            assert.strictEqual(lastAttemptPassTests.length, NUM_RETRIES_EFD + 1)
            assert.strictEqual(
              lastAttemptPassTests.filter(test => test.meta[TEST_STATUS] === 'fail').length,
              NUM_RETRIES_EFD
            )
            assert.strictEqual(lastAttemptPassTests[lastAttemptPassTests.length - 1].meta[TEST_STATUS], 'pass')
            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'pass')
            assert.strictEqual(testSessionEvent.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              SHOULD_ADD_EVENTUALLY_FAIL: '1',
              SHOULD_ADD_LAST_ATTEMPT_PASS: '1',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 0)
            done()
          }).catch(done)
        })
      })

      it('uses the retry count from the matching slow_test_retries bucket', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': 1,
              '10s': 0,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {},
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            const instantTests = tests.filter(test =>
              test.meta[TEST_NAME] === 'early flake detection can retry tests that always pass'
            )
            assert.strictEqual(instantTests.length, 2)
            assert.strictEqual(
              instantTests.filter(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd).length,
              1
            )

            const slowTests = tests.filter(test =>
              test.meta[TEST_NAME] === 'early flake detection slightly slow duration bucket test'
            )
            assert.strictEqual(slowTests.length, 1)
            assert.strictEqual(slowTests[0].meta[TEST_IS_NEW], 'true')
            assert.strictEqual(slowTests[0].meta[TEST_EARLY_FLAKE_ABORT_REASON], 'slow')
            assert.ok(!(TEST_IS_RETRY in slowTests[0].meta))
          }, 55_000)

        childProcess = exec(
          './node_modules/.bin/vitest run -t "can retry tests that always pass|slightly slow duration bucket test"',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              SHOULD_ADD_SLOW_DURATION_TEST: '1',
            },
          }
        )

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
        assert.strictEqual(exitCode, 0)
      })

      it('reports the error from each failed EFD attempt', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': 9,
            },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {},
        })

        const testName = 'early flake detection reports the current failed attempt error'
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events
              .filter(event => event.type === 'test')
              .map(test => test.content)
              .filter(test => test.meta[TEST_NAME] === testName)
              .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

            assert.strictEqual(tests.length, 10)

            const failedAttempts = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.deepStrictEqual(
              failedAttempts.map(test => ({
                isRetry: test.meta[TEST_IS_RETRY],
                retryReason: test.meta[TEST_RETRY_REASON],
                errorType: test.meta[ERROR_TYPE],
                errorMessage: test.meta[ERROR_MESSAGE],
              })),
              [
                {
                  isRetry: undefined,
                  retryReason: undefined,
                  errorType: 'Error',
                  errorMessage: 'failure 0',
                },
                {
                  isRetry: 'true',
                  retryReason: TEST_RETRY_REASON_TYPES.efd,
                  errorType: 'Error',
                  errorMessage: 'failure 2',
                },
                {
                  isRetry: 'true',
                  retryReason: TEST_RETRY_REASON_TYPES.efd,
                  errorType: 'Error',
                  errorMessage: 'failure 5',
                },
                {
                  isRetry: 'true',
                  retryReason: TEST_RETRY_REASON_TYPES.efd,
                  errorType: 'Error',
                  errorMessage: 'failure 8',
                },
              ]
            )
            failedAttempts.forEach(test => {
              assert.ok(
                test.meta[ERROR_STACK],
                `Expected failed attempt error stack. Test event: ${inspect(test)}`
              )
            })
          }, 55_000)

        childProcess = exec(
          './node_modules/.bin/vitest run -t "reports the current failed attempt error"',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              SHOULD_ADD_CURRENT_ERROR_TEST: '1',
            },
          }
        )

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
        assert.strictEqual(exitCode, 0)
      })

      newerVitestIt('disables manual Vitest retries for new tests retried by EFD', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': 2,
            },
            faulty_session_threshold: 100,
          },
          flaky_test_retries_enabled: false,
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {},
        })

        const testName = 'efd with manual vitest retries fails first then passes'
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events
              .filter(event => event.type === 'test')
              .map(test => test.content)
              .filter(test => test.meta[TEST_NAME] === testName)
              .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

            const diagnosticTests = tests.map(test => ({
              status: test.meta[TEST_STATUS],
              isRetry: test.meta[TEST_IS_RETRY],
              retryReason: test.meta[TEST_RETRY_REASON],
            }))
            assert.deepStrictEqual(diagnosticTests, [
              { status: 'fail', isRetry: undefined, retryReason: undefined },
              { status: 'fail', isRetry: 'true', retryReason: TEST_RETRY_REASON_TYPES.efd },
              { status: 'pass', isRetry: 'true', retryReason: TEST_RETRY_REASON_TYPES.efd },
            ])
          }, 55_000)

        childProcess = exec(
          './node_modules/.bin/vitest run --retry=1',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/fails-first-then-passes.mjs',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
        assert.strictEqual(exitCode, 0)
      })

      it('fails if all the attempts fail', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // skipped so not retried
              'early flake detection does not retry if it is not new',
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 10)

            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
            ])
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            // 4 executions of the 2 new tests + 1 new skipped test (not retried)
            assert.strictEqual(newTests.length, 9)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 6) // 3 retries of the 2 new tests

            // the multiple attempts did not result in a single pass,
            // so the test session should be reported as failed
            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 6)
            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testSessionEvent.meta[TEST_EARLY_FLAKE_ENABLED], 'true')

            // Check that TEST_HAS_FAILED_ALL_RETRIES is set for tests that fail all EFD attempts
            const alwaysFailTests = tests.filter(test =>
              test.meta[TEST_NAME] === 'early flake detection can retry tests that always pass'
            )
            assert.strictEqual(alwaysFailTests.length, 4) // 1 initial + 3 retries
            // The last execution should have TEST_HAS_FAILED_ALL_RETRIES set
            const testsWithFlag = alwaysFailTests.filter(test =>
              test.meta[TEST_HAS_FAILED_ALL_RETRIES] === 'true'
            )
            assert.strictEqual(
              testsWithFlag.length,
              1,
              'Exactly one test should have TEST_HAS_FAILED_ALL_RETRIES set'
            )
            // It should be the last one
            const lastAttempt = alwaysFailTests[alwaysFailTests.length - 1]
            assert.strictEqual(
              lastAttempt.meta[TEST_HAS_FAILED_ALL_RETRIES],
              'true',
              'Last attempt should have the flag'
            )
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              ALWAYS_FAIL: 'true',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      nativeModuleRunnerIt('reports a deterministic failure with native module loading', async function () {
        this.timeout(60_000)
        testOutput = ''

        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })
        receiver.setKnownTests({ vitest: {} })

        childProcess = exec(
          './node_modules/.bin/vitest run --reporter=json --outputFile=efd-results.json',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              TEST_DIR: 'ci-visibility/vitest-tests/efd-retries.mjs',
              VITEST_NATIVE_MODULE_RUNNER: 'true',
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

      nativeModuleRunnerIt('reports success when an EFD attempt passes with native module loading', async function () {
        this.timeout(60_000)
        testOutput = ''

        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })
        receiver.setKnownTests({ vitest: {} })

        childProcess = exec(
          './node_modules/.bin/vitest run --reporter=json --outputFile=efd-results.json',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              TEST_DIR: 'ci-visibility/vitest-tests/efd-retries.mjs',
              VITEST_NATIVE_MODULE_RUNNER: 'true',
              EFD_PASS_ATTEMPT: '2',
            },
          }
        )
        childProcess.stdout.on('data', data => { testOutput += data })
        childProcess.stderr.on('data', data => { testOutput += data })

        const [[code, signal]] = await Promise.all([
          once(childProcess, 'exit'),
          receiver.gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url === '/api/v2/citestcycle',
            payloads => {
              const tests = payloads
                .flatMap(({ payload }) => payload.events)
                .filter(event => event.type === 'test')
                .map(event => event.content)

              assert.ok(tests.some(test => test.meta[TEST_STATUS] === 'fail'), testOutput)
              assert.ok(tests.some(test => test.meta[TEST_STATUS] === 'pass'), testOutput)
            }
          ),
        ])

        assert.strictEqual(signal, null, testOutput)
        assert.strictEqual(code, 0, testOutput)

        const report = JSON.parse(fs.readFileSync(path.join(cwd, 'efd-results.json'), 'utf8'))
        const assertionResults = report.testResults.flatMap(({ assertionResults }) => assertionResults)

        assert.strictEqual(report.success, true)
        assert.strictEqual(assertionResults.length, 1)
        assert.strictEqual(assertionResults[0].status, 'passed')
      })

      it('bails out of EFD if the percentage of new tests is too high', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
            faulty_session_threshold: 0,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {},
        }) // tests from ci-visibility/vitest-tests/early-flake-detection.mjs will be new

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
            assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 4)

            const newTests = tests.filter(
              test => test.meta[TEST_IS_NEW] === 'true'
            )
            assert.strictEqual(newTests.length, version === 'latest' && NODE_MAJOR >= 20 ? 4 : 0)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      runtimeEfdSuiteAdmissionIt('stops EFD retries after too many suites with new tests are detected', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': 2,
            },
            faulty_session_threshold: 1,
          },
          known_tests_enabled: true,
        })
        receiver.setKnownTests({ vitest: {} })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
            assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 4)
            assert.strictEqual(new Set(tests.map(test => test.meta[TEST_SUITE])).size, 2)
            tests.forEach(test => assert.strictEqual(test.meta[TEST_IS_NEW], 'true'))

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 2)
            assert.strictEqual(new Set(retriedTests.map(test => test.meta[TEST_SUITE])).size, 1)
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/efd-suite-admission-*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              POOL_CONFIG: 'threads',
            },
          }
        )

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
        assert.strictEqual(exitCode, 0)
      })

      it('is disabled if DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED is false', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // will be considered new
              'early flake detection does not retry if it is not new',
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 4)

            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
            ])

            // new tests are detected but not retried
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, 3)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 1)
            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              DD_CIVISIBILITY_EARLY_FLAKE_DETECTION_ENABLED: 'false',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('does not run EFD if the known tests request fails', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTestsResponseCode(500)
        receiver.setKnownTests({})

        // Request module waits before retrying — need longer gather timeout
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 4)

            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
            ])
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, 0)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 1)
            const testSessionEnd = events.find(event => event.type === 'test_session_end')
            assert.ok(testSessionEnd, 'expected test_session_end event in payloads')
            const testSessionEvent = testSessionEnd.content
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSessionEvent.meta))
          }, 60000)

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('works when the cwd is not the repository root', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/subproject/vitest-test.mjs': [
              'context can report passed test', // no test will be considered new
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            // no retries
            assert.strictEqual(tests.length, 1)

            assert.strictEqual(tests[0].meta[TEST_SUITE], 'ci-visibility/subproject/vitest-test.mjs')
            // it's not considered new
            assert.ok(!(TEST_IS_NEW in tests[0].meta))
          })

        childProcess = exec(
          '../../node_modules/.bin/vitest run',
          {
            cwd: `${cwd}/ci-visibility/subproject`,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
              TEST_DIR: './vitest-test.mjs',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 0)
            done()
          }).catch(done)
        })
      })

      it('works with repeats config when EFD is disabled', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: false,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection can retry tests that eventually fail', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // will be considered new
              'early flake detection does not retry if it is not new',
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 8)

            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that always pass',
              'early flake detection can retry tests that eventually pass', // repeated twice
              'early flake detection can retry tests that always pass', // repeated twice
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
            ])
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            // all but one are considered new
            assert.strictEqual(newTests.length, 7)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 4) // 2 repetitions on 2 tests

            // vitest reports the test as failed if any of the repetitions fail, so we'll follow that
            // TODO: we might want to improve this
            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 3)

            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
            assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSessionEvent.meta))
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              SHOULD_REPEAT: '1',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('disables early flake detection if known tests should not be requested', (done) => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: {
              '5s': NUM_RETRIES_EFD,
            },
          },
          known_tests_enabled: false,
        })

        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/early-flake-detection.mjs': [
              // 'early flake detection can retry tests that eventually pass', // will be considered new
              // 'early flake detection can retry tests that always pass', // will be considered new
              // 'early flake detection does not retry if the test is skipped', // will be considered new
              'early flake detection does not retry if it is not new',
            ],
          },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const tests = events.filter(event => event.type === 'test').map(test => test.content)

            assert.strictEqual(tests.length, 4)

            assertObjectContains(tests.map(test => test.meta[TEST_NAME]), [
              'early flake detection can retry tests that eventually pass',
              'early flake detection can retry tests that always pass',
              'early flake detection does not retry if it is not new',
              'early flake detection does not retry if the test is skipped',
            ])

            // new tests are not detected and not retried
            const newTests = tests.filter(test => test.meta[TEST_IS_NEW] === 'true')
            assert.strictEqual(newTests.length, 0)

            const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
            assert.strictEqual(retriedTests.length, 0)

            const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTests.length, 1)
            const testSessionEvent = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSessionEvent.meta[TEST_STATUS], 'fail')
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )

        childProcess.on('exit', (exitCode) => {
          eventsPromise.then(() => {
            assert.strictEqual(exitCode, 1)
            done()
          }).catch(done)
        })
      })

      it('does not detect new tests if the response is invalid', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
          },
          known_tests_enabled: true,
        })

        receiver.setKnownTests({
          'not-vitest': {},
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ABORT_REASON], 'faulty')

            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            assert.strictEqual(tests.length, 4)

            const newTests = tests.filter(
              test => test.meta[TEST_IS_NEW] === 'true'
            )
            // no new tests
            assert.strictEqual(newTests.length, 0)
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/early-flake-detection*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )
        await Promise.all([
          once(childProcess, 'exit'),
          eventsPromise,
        ])
      })

      it('tags new tests with dynamic names and logs a warning', async () => {
        receiver.setSettings({
          early_flake_detection: {
            enabled: true,
            slow_test_retries: { '5s': 1 },
            faulty_session_threshold: 100,
          },
          known_tests_enabled: true,
        })
        receiver.setKnownTests({ vitest: {} })

        const eventsPromise = receiver.gatherPayloadsMaxTimeout(
          ({ url }) => url === '/api/v2/citestcycle',
          (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            const uniqueTests = new Map()
            for (const test of tests) {
              if (!uniqueTests.has(test.meta[TEST_NAME])) {
                uniqueTests.set(test.meta[TEST_NAME], test)
              }
            }

            const dynamicTests = [...uniqueTests.values()]
              .filter(test => test.meta[TEST_HAS_DYNAMIC_NAME] === 'true')
            assert.strictEqual(dynamicTests.length, 8)

            dynamicTests.forEach(test => {
              assert.strictEqual(test.meta[TEST_IS_NEW], 'true')
            })
          }
        )

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/dynamic-name-test*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )

        let testOutput = ''
        childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
        childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

        await Promise.all([once(childProcess, 'exit'), eventsPromise])

        assert.match(testOutput, /detected as new but their names contain dynamic data/)
      })
    })

    // dynamic instrumentation only supported from >=2.0.0
    {
      const dynamicInstrumentationContext = version === 'latest' ? context : context.skip

      dynamicInstrumentationContext('dynamic instrumentation', () => {
        it('does not activate it if DD_TEST_FAILED_TEST_REPLAY_ENABLED is set to false', (done) => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            di_enabled: true,
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

              assert.strictEqual(retriedTests.length, 1)
              const [retriedTest] = retriedTests

              const hasDebugTags = Object.keys(retriedTest.meta)
                .some(property =>
                  property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED
                )

              assert.strictEqual(hasDebugTags, false)
            })

          const logsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
              if (payloads.length > 0) {
                throw new Error('Unexpected logs')
              }
            }, 5000)

          childProcess = exec(
            './node_modules/.bin/vitest run --retry=1',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/dynamic-instrumentation*',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
                DD_TEST_FAILED_TEST_REPLAY_ENABLED: 'false',
              },
            }
          )

          childProcess.on('exit', () => {
            Promise.all([eventsPromise, logsPromise]).then(() => {
              done()
            }).catch(done)
          })
        })

        it('does not activate dynamic instrumentation if remote settings are disabled', (done) => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            di_enabled: false,
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

              assert.strictEqual(retriedTests.length, 1)
              const [retriedTest] = retriedTests
              const hasDebugTags = Object.keys(retriedTest.meta)
                .some(property =>
                  property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED
                )

              assert.strictEqual(hasDebugTags, false)
            })

          const logsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
              if (payloads.length > 0) {
                throw new Error('Unexpected logs')
              }
            }, 5000)

          childProcess = exec(
            './node_modules/.bin/vitest run --retry=1',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/dynamic-instrumentation*',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              },
            }
          )

          childProcess.on('exit', () => {
            Promise.all([eventsPromise, logsPromise]).then(() => {
              done()
            }).catch(done)
          })
        })

        it('runs retries with dynamic instrumentation', (done) => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            di_enabled: true,
          })

          let snapshotIdByTest, snapshotIdByLog
          let spanIdByTest, spanIdByLog, traceIdByTest, traceIdByLog

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

              assert.strictEqual(retriedTests.length, 1)
              const [retriedTest] = retriedTests

              assert.strictEqual(retriedTest.meta[DI_ERROR_DEBUG_INFO_CAPTURED], 'true')

              assert.strictEqual(retriedTest.meta[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_FILE_SUFFIX}`]
                .endsWith('ci-visibility/vitest-tests/bad-sum.mjs'), true)
              assert.strictEqual(retriedTest.metrics[`${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_LINE_SUFFIX}`], 4)

              const snapshotIdKey = `${DI_DEBUG_ERROR_PREFIX}.0.${DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX}`
              assert.ok(retriedTest.meta[snapshotIdKey])

              snapshotIdByTest = retriedTest.meta[snapshotIdKey]
              spanIdByTest = retriedTest.span_id.toString()
              traceIdByTest = retriedTest.trace_id.toString()

              const notRetriedTest = tests.find(test => test.meta[TEST_NAME].includes('is not retried'))

              assert.ok(!('DI_ERROR_DEBUG_INFO_CAPTURED' in notRetriedTest.meta))
            })

          const logsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
              const [{ logMessage: [diLog] }] = payloads
              assertObjectContains(diLog, {
                ddsource: 'dd_debugger',
                level: 'error',
              })
              assert.match(diLog.ddtags, /git.repository_url:/)
              assert.match(diLog.ddtags, /git.commit.sha:/)
              assert.strictEqual(diLog.debugger.snapshot.language, 'javascript')
              assertObjectContains(diLog.debugger.snapshot.captures.lines['4'].locals, {
                a: {
                  type: 'number',
                  value: '11',
                },
                b: {
                  type: 'number',
                  value: '2',
                },
                localVar: {
                  type: 'number',
                  value: '10',
                },
              })
              spanIdByLog = diLog.dd.span_id
              traceIdByLog = diLog.dd.trace_id
              snapshotIdByLog = diLog.debugger.snapshot.id
            }, 5000)

          childProcess = exec(
            './node_modules/.bin/vitest run --retry=1',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/dynamic-instrumentation*',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              },
            }
          )

          childProcess.on('exit', () => {
            Promise.all([eventsPromise, logsPromise]).then(() => {
              assert.strictEqual(snapshotIdByTest, snapshotIdByLog)
              assert.strictEqual(spanIdByTest, spanIdByLog)
              assert.strictEqual(traceIdByTest, traceIdByLog)
              done()
            }).catch(done)
          })
        })

        it('runs multiple retries with dynamic instrumentation', async () => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            di_enabled: true,
          })

          const retrySpanIdsWithDebugInfo = new Set()
          const diLogSpanIds = []
          let testOutput = ''

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

              assert.strictEqual(retriedTests.length, 3)
              for (const retriedTest of retriedTests) {
                if (retriedTest.meta[DI_ERROR_DEBUG_INFO_CAPTURED] === 'true') {
                  retrySpanIdsWithDebugInfo.add(retriedTest.span_id.toString())
                }
              }
              assert.strictEqual(retrySpanIdsWithDebugInfo.size, 2)
            })

          const logsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
              const diLogs = payloads.flatMap(({ logMessage }) => logMessage)
              assert.strictEqual(diLogs.length, 2)
              for (const diLog of diLogs) {
                diLogSpanIds.push(diLog.dd.span_id)
              }
            })

          childProcess = exec(
            './node_modules/.bin/vitest run --retry=3',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/ftr-multiple-retries.mjs',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
                _DD_TRACE_INTEGRATION_COVERAGE_DISABLE: '1',
              },
            }
          )

          childProcess.stdout?.on('data', (chunk) => {
            testOutput += chunk.toString()
          })
          childProcess.stderr?.on('data', (chunk) => {
            testOutput += chunk.toString()
          })
          const stdoutEndPromise = childProcess.stdout ? once(childProcess.stdout, 'end') : Promise.resolve()
          const stderrEndPromise = childProcess.stderr ? once(childProcess.stderr, 'end') : Promise.resolve()

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            eventsPromise,
            logsPromise,
            stdoutEndPromise,
            stderrEndPromise,
          ])
          assert.strictEqual(exitCode, 0, testOutput)
          assert.doesNotMatch(testOutput, /Breakpoint snapshot could not be attached to the active test span/)
          for (const diLogSpanId of diLogSpanIds) {
            assert.ok(retrySpanIdsWithDebugInfo.has(diLogSpanId))
          }
        })

        it('does not run Failed Test Replay for files with concurrent tests', async () => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            di_enabled: true,
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

              assert.strictEqual(retriedTests.length, 1)
              const [retriedTest] = retriedTests
              assert.strictEqual(
                retriedTest.meta[TEST_NAME],
                'dynamic instrumentation with concurrent tests serial retry does not use Failed Test Replay'
              )

              const hasDebugTags = Object.keys(retriedTest.meta)
                .some(property =>
                  property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED
                )
              assert.strictEqual(hasDebugTags, false)
            })

          const logsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
              if (payloads.length > 0) {
                throw new Error('Unexpected logs')
              }
            }, 5000)

          childProcess = exec(
            './node_modules/.bin/vitest run --retry=1',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/concurrent-ftr-disabled.mjs',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              },
            }
          )

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            eventsPromise,
            logsPromise,
          ])
          assert.strictEqual(exitCode, 0)
        })

        it('does not crash if the retry does not hit the breakpoint', (done) => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            di_enabled: true,
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')

              assert.strictEqual(retriedTests.length, 1)
              const [retriedTest] = retriedTests

              const hasDebugTags = Object.keys(retriedTest.meta)
                .some(property =>
                  property.startsWith(DI_DEBUG_ERROR_PREFIX) || property === DI_ERROR_DEBUG_INFO_CAPTURED
                )

              assert.strictEqual(hasDebugTags, false)
            })

          const logsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/logs'), (payloads) => {
              if (payloads.length > 0) {
                throw new Error('Unexpected logs')
              }
            }, 5000)

          childProcess = exec(
            './node_modules/.bin/vitest run --retry=1',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/breakpoint-not-hit*',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              },
            }
          )

          childProcess.on('exit', () => {
            Promise.all([eventsPromise, logsPromise]).then(() => {
              done()
            }).catch(done)
          })
        })

        it('does not hang when tests use fake timers and Failed Test Replay is enabled', async () => {
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            di_enabled: true,
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)
              assert.strictEqual(tests.length, 2)
              const retriedTests = tests.filter(t => t.meta[TEST_IS_RETRY] === 'true')
              assert.strictEqual(retriedTests.length, 1)
            })

          childProcess = exec(
            './node_modules/.bin/vitest run --retry=1',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/fake-timers-di*',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              },
            }
          )

          const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), eventsPromise])
          assert.strictEqual(exitCode, 1)
        })
      })
    }
  })
})

// Keep the legacy fork transport covered independently of the broad oldest/latest matrix.
// Runtime EFD suite admission starts at Vitest 4, which requires Node.js >=20.
const describeTransport = NODE_MAJOR >= 20 && runVersionIndependentSuites ? describe : describe.skip

for (const version of ['4.0.5', 'latest']) {
  describeTransport(`vitest@${version} EFD worker transport`, () => {
    useSandbox([`vitest@${version}`], true)

    for (const pool of ['forks', 'threads']) {
      it(`retries a passing test without unhandled IPC errors in ${pool}`, async function () {
        this.timeout(60_000)
        const receiver = await new FakeCiVisIntake().start()
        let childProcess
        let output = ''
        try {
          receiver.setSettings({
            known_tests_enabled: true,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: { '5s': 2 },
              faulty_session_threshold: 100,
            },
          })
          receiver.setKnownTests({ vitest: {} })
          childProcess = exec('./node_modules/.bin/vitest run', {
            cwd: sandboxCwd(),
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              TEST_DIR: 'ci-visibility/vitest-tests/efd-suite-admission-first.mjs',
              POOL_CONFIG: pool,
            },
          })
          childProcess.stdout.on('data', data => { output += data })
          childProcess.stderr.on('data', data => { output += data })

          const [[code, signal]] = await Promise.all([
            once(childProcess, 'exit'),
            receiver.gatherPayloadsUntilChildExit(
              childProcess,
              ({ url }) => url === '/api/v2/citestcycle',
              payloads => {
                const tests = payloads.flatMap(({ payload }) => payload.events)
                  .filter(event => event.type === 'test').map(event => event.content)
                assert.strictEqual(tests.length, 3, output)
                assert.ok(tests.every(test => test.meta[TEST_STATUS] === 'pass'), output)
                const retries = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
                assert.strictEqual(retries.length, 2, output)
                assert.ok(retries.every(test => test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd), output)
              }
            ),
          ])
          assert.strictEqual(signal, null, output)
          assert.strictEqual(code, 0, output)
          assert.doesNotMatch(output, /Unhandled (?:Errors|Rejection)|Unable to deserialize/)
        } finally {
          childProcess?.kill()
          await receiver.stop()
        }
      })
    }
  })
}
