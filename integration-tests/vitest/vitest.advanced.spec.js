'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { exec, execSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const { inspect } = require('node:util')
const { assertObjectContains } = require('../helpers')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  TEST_STATUS,
  TEST_TYPE,
  TEST_IS_RETRY,
  TEST_SESSION_NAME,
  TEST_SOURCE_FILE,
  TEST_IS_NEW,
  TEST_NAME,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_RETRY_REASON,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_IS_DISABLED,
  DD_CAPABILITIES_TEST_IMPACT_ANALYSIS,
  DD_CAPABILITIES_EARLY_FLAKE_DETECTION,
  DD_CAPABILITIES_AUTO_TEST_RETRIES,
  DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE,
  DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE,
  DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX,
  DD_CAPABILITIES_FAILED_TEST_REPLAY,
  TEST_RETRY_REASON_TYPES,
  TEST_IS_MODIFIED,
  DD_CAPABILITIES_IMPACTED_TESTS,
  GIT_COMMIT_SHA,
  GIT_REPOSITORY_URL,
  TEST_FINAL_STATUS,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { TELEMETRY_COVERAGE_UPLOAD } = require('../../packages/dd-trace/src/ci-visibility/telemetry')
const { NODE_MAJOR } = require('../../version')

const NUM_RETRIES_EFD = 3

// vitest@4.x requires Node.js >= 20
const versions = NODE_MAJOR <= 18 ? ['1.6.0', '3'] : ['1.6.0', 'latest']

versions.forEach((version) => {
  describe(`vitest@${version}`, () => {
    let cwd, receiver, childProcess, testOutput

    useSandbox([
      `vitest@${version}`,
      `@vitest/coverage-istanbul@${version}`,
      `@vitest/coverage-v8@${version}`,
      'tinypool',
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

    context('libraries capabilities', () => {
      it('adds capabilities to tests', (done) => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

            assert.ok(metadataDicts.length > 0, `Expected ${metadataDicts.length} > 0`)
            metadataDicts.forEach(metadata => {
              assert.ok(
                !Object.hasOwn(metadata.test, DD_CAPABILITIES_TEST_IMPACT_ANALYSIS),
                `Available keys: ${inspect(Object.keys(metadata.test))}`
              )

              assertObjectContains(metadata.test, {
                [DD_CAPABILITIES_EARLY_FLAKE_DETECTION]: '1',
                [DD_CAPABILITIES_AUTO_TEST_RETRIES]: '1',
                [DD_CAPABILITIES_IMPACTED_TESTS]: '1',
                [DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE]: '1',
                [DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE]: '1',
                [DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX]: '5',
                [DD_CAPABILITIES_FAILED_TEST_REPLAY]: '1',
              })
              // capabilities logic does not overwrite test session name
              assert.strictEqual(metadata['*'][TEST_SESSION_NAME], 'my-test-session-name')
            })
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              // Creates a span after ci/init but before library configuration adds capability metadata.
              NODE_OPTIONS:
                '--import dd-trace/register.js -r dd-trace/ci/init -r ./ci-visibility/vitest-early-span',
              DD_TEST_SESSION_NAME: 'my-test-session-name',
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

    context('impacted tests', () => {
      beforeEach(() => {
        receiver.setKnownTests({
          vitest: {
            'ci-visibility/vitest-tests/impacted-test.mjs': [
              'impacted test can impacted test',
            ],
          },
        })
      })

      // Modify `impacted-test.mjs` to mark it as impacted
      before(() => {
        execSync('git checkout -b feature-branch', { cwd, stdio: 'ignore' })
        fs.writeFileSync(
          path.join(cwd, 'ci-visibility/vitest-tests/impacted-test.mjs'),
          `import { describe, test, expect } from 'vitest'
           describe('impacted test', () => {
             test('can impacted test', () => {
               assert.strictEqual(1 + 2, 4)
             })
           })`
        )
        execSync('git add ci-visibility/vitest-tests/impacted-test.mjs', { cwd, stdio: 'ignore' })
        execSync('git commit -m "modify impacted-test.mjs"', { cwd, stdio: 'ignore' })
      })

      after(() => {
        execSync('git checkout -', { cwd, stdio: 'ignore' })
        execSync('git branch -D feature-branch', { cwd, stdio: 'ignore' })
      })

      /**
       * @param {{
       *   isModified?: boolean,
       *   isEfd?: boolean,
       *   isNew?: boolean,
       * }} options
       */
      const getTestAssertions = ({ isModified, isEfd, isNew }) =>
        receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)
            const testSession = events.find(event => event.type === 'test_session_end').content

            if (isEfd) {
              assert.strictEqual(testSession.meta[TEST_EARLY_FLAKE_ENABLED], 'true')
            } else {
              assert.ok(!(TEST_EARLY_FLAKE_ENABLED in testSession.meta))
            }

            const resourceNames = tests.map(span => span.resource)

            assertObjectContains(resourceNames,
              [
                'ci-visibility/vitest-tests/impacted-test.mjs.impacted test can impacted test',
              ]
            )

            const impactedTests = tests.filter(test =>
              test.meta[TEST_SOURCE_FILE] === 'ci-visibility/vitest-tests/impacted-test.mjs' &&
              test.meta[TEST_NAME] === 'impacted test can impacted test')

            if (isEfd) {
              assert.strictEqual(impactedTests.length, NUM_RETRIES_EFD + 1) // Retries + original test
            } else {
              assert.strictEqual(impactedTests.length, 1)
            }

            for (const impactedTest of impactedTests) {
              if (isModified) {
                assert.strictEqual(impactedTest.meta[TEST_IS_MODIFIED], 'true')
              } else {
                assert.ok(!(TEST_IS_MODIFIED in impactedTest.meta))
              }
              if (isNew) {
                assert.strictEqual(impactedTest.meta[TEST_IS_NEW], 'true')
              } else {
                assert.ok(!(TEST_IS_NEW in impactedTest.meta))
              }
            }

            if (isEfd) {
              const retriedTests = tests.filter(test => test.meta[TEST_IS_RETRY] === 'true')
              assert.strictEqual(retriedTests.length, NUM_RETRIES_EFD)
              let retriedTestNew = 0
              let retriedTestsWithReason = 0
              retriedTests.forEach(test => {
                if (test.meta[TEST_IS_NEW] === 'true') {
                  retriedTestNew++
                }
                if (test.meta[TEST_RETRY_REASON] === TEST_RETRY_REASON_TYPES.efd) {
                  retriedTestsWithReason++
                }
              })
              assert.strictEqual(retriedTestNew, isNew ? NUM_RETRIES_EFD : 0)
              assert.strictEqual(retriedTestsWithReason, NUM_RETRIES_EFD)
            }
          })

      const runImpactedTest = (
        done,
        { isModified, isEfd = false, isNew = false },
        extraEnvVars = {}
      ) => {
        const testAssertionsPromise = getTestAssertions({ isModified, isEfd, isNew })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/impacted-test*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
              GITHUB_BASE_REF: '',
              ...extraEnvVars,
            },
          }
        )

        childProcess.on('exit', () => {
          testAssertionsPromise.then(done).catch(done)
        })
      }

      context('test is not new', () => {
        it('should be detected as impacted', (done) => {
          receiver.setSettings({ impacted_tests_enabled: true })

          runImpactedTest(done, { isModified: true })
        })

        it('should not be detected as impacted if disabled', (done) => {
          receiver.setSettings({ impacted_tests_enabled: false })

          runImpactedTest(done, { isModified: false })
        })

        it('should not be detected as impacted if DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED is false',
          (done) => {
            receiver.setSettings({ impacted_tests_enabled: true })

            runImpactedTest(done,
              { isModified: false },
              { DD_CIVISIBILITY_IMPACTED_TESTS_DETECTION_ENABLED: '0' }
            )
          })
      })

      context('test is new', () => {
        it('should be retried and marked both as new and modified', (done) => {
          receiver.setKnownTests({
            vitest: {},
          })
          receiver.setSettings({
            impacted_tests_enabled: true,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: {
                '5s': NUM_RETRIES_EFD,
              },
            },
            known_tests_enabled: true,
          })
          runImpactedTest(done, { isModified: true, isEfd: true, isNew: true })
        })
      })
    })

    it('does not blow up when tinypool is used outside of a test', (done) => {
      childProcess = exec('node ./ci-visibility/run-tinypool.mjs', {
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
        assert.match(testOutput, /result 10/)
        assert.strictEqual(code, 0)
        done()
      })
    })

    context('programmatic api', () => {
      it('can report data using the vitest programmatic api', async () => {
        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSessionEvent = events.find(event => event.type === 'test_session_end')
            const testModuleEvent = events.find(event => event.type === 'test_module_end')
            const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
            const testEvents = events.filter(event => event.type === 'test')

            assert.strictEqual(testSessionEvent.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testModuleEvent.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(testSessionEvent.content.meta[TEST_TYPE], 'test')
            assert.strictEqual(testModuleEvent.content.meta[TEST_TYPE], 'test')

            const testSuite = testSuiteEvents.find(
              suite => suite.content.resource ===
                'test_suite.ci-visibility/vitest-tests-programmatic-api/test-programmatic-api.mjs'
            )
            assert.strictEqual(testSuite.content.meta[TEST_STATUS], 'fail')

            assert.strictEqual(testEvents.length, 3)
          })

        childProcess = exec(
          'node run-programmatic-api.mjs',
          {
            cwd: `${cwd}/ci-visibility/vitest-tests-programmatic-api`,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              TEST_DIR: './test-programmatic-api*',
            },
          }
        )

        await Promise.all([
          eventsPromise,
          once(childProcess, 'exit'),
        ])
      })
    })

    // Coverage report upload only works for >=2.0.0 (when vitest has proper coverage support)
    // v4 dropped support for Node 18
    if (version === 'latest' && NODE_MAJOR >= 20) {
      context('coverage report upload', () => {
        const gitCommitSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        const gitRepositoryUrl = 'https://github.com/datadog/test-repo.git'

        it('uploads coverage report when coverage_report_upload_enabled is true', async () => {
          receiver.setSettings({
            coverage_report_upload_enabled: true,
          })

          const coverageReportPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/cicovreprt', (payloads) => {
              assert.strictEqual(payloads.length, 1)

              const coverageReport = payloads[0]

              assert.ok(
                coverageReport.headers['content-type'].includes('multipart/form-data'),
                `Got: ${inspect(coverageReport.headers['content-type'])}`
              )

              assert.strictEqual(coverageReport.coverageFile.name, 'coverage')
              assert.ok(
                coverageReport.coverageFile.content.includes('SF:'),
                `Got: ${inspect(coverageReport.coverageFile.content)}`
              ) // LCOV format

              assert.strictEqual(coverageReport.eventFile.name, 'event')
              assert.strictEqual(coverageReport.eventFile.content.type, 'coverage_report')
              assert.strictEqual(coverageReport.eventFile.content.format, 'lcov')
              assert.strictEqual(coverageReport.eventFile.content[GIT_COMMIT_SHA], gitCommitSha)
              assert.strictEqual(coverageReport.eventFile.content[GIT_REPOSITORY_URL], gitRepositoryUrl)
            })

          childProcess = exec(
            './node_modules/.bin/vitest run --coverage',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
                COVERAGE_PROVIDER: 'v8',
                TEST_DIR: 'ci-visibility/vitest-tests/coverage-test.mjs',
                DD_GIT_COMMIT_SHA: gitCommitSha,
                DD_GIT_REPOSITORY_URL: gitRepositoryUrl,
              },
            }
          )

          await Promise.all([
            coverageReportPromise,
            once(childProcess, 'exit'),
          ])
        })

        it('sends coverage_upload.request telemetry metric when coverage is uploaded', async () => {
          receiver.setSettings({
            coverage_report_upload_enabled: true,
          })
          receiver.setInfoResponse({ endpoints: ['/evp_proxy/v4'] })

          const telemetryPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/apmtelemetry'), (payloads) => {
              const telemetryMetrics = payloads.flatMap(({ payload }) => payload.payload.series)

              const coverageUploadMetric = telemetryMetrics.find(
                ({ metric }) => metric === TELEMETRY_COVERAGE_UPLOAD
              )

              assert.ok(coverageUploadMetric, 'coverage_upload.request telemetry metric should be sent')
            })

          childProcess = exec(
            './node_modules/.bin/vitest run --coverage',
            {
              cwd,
              env: {
                ...getCiVisEvpProxyConfig(receiver.port),
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
                DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'true',
                COVERAGE_PROVIDER: 'v8',
                TEST_DIR: 'ci-visibility/vitest-tests/coverage-test.mjs',
                DD_GIT_COMMIT_SHA: gitCommitSha,
                DD_GIT_REPOSITORY_URL: gitRepositoryUrl,
              },
            }
          )

          await Promise.all([
            once(childProcess, 'exit'),
            telemetryPromise,
          ])
        })

        it('does not upload coverage report when coverage_report_upload_enabled is false', async () => {
          receiver.setSettings({
            coverage_report_upload_enabled: false,
          })

          let coverageReportUploaded = false
          receiver.assertPayloadReceived(() => {
            coverageReportUploaded = true
          }, ({ url }) => url === '/api/v2/cicovreprt')

          childProcess = exec(
            './node_modules/.bin/vitest run --coverage',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
                COVERAGE_PROVIDER: 'v8',
                TEST_DIR: 'ci-visibility/vitest-tests/coverage-test.mjs',
                DD_GIT_COMMIT_SHA: gitCommitSha,
                DD_GIT_REPOSITORY_URL: gitRepositoryUrl,
              },
            }
          )

          await once(childProcess, 'exit')

          assert.strictEqual(coverageReportUploaded, false, 'coverage report should not be uploaded')
        })
      })
    }

    context('final status tag', () => {
      it('sets final_status tag to test status on regular tests without retry features', async () => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: false,
          early_flake_detection: { enabled: false },
        })

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tests = events.filter(event => event.type === 'test').map(event => event.content)

            tests.forEach(test => {
              assert.strictEqual(
                test.meta[TEST_FINAL_STATUS],
                test.meta[TEST_STATUS],
                `Expected TEST_FINAL_STATUS to match TEST_STATUS for test "${test.meta[TEST_NAME]}"`
              )
            })
          })

        childProcess = exec(
          './node_modules/.bin/vitest run',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              // Runs test-visibility-passed-suite (pass/skip), test-visibility-failed-suite
              // (fail/pass with hooks), and test-visibility-failed-hooks (fail due to hook throws)
              TEST_DIR: 'ci-visibility/vitest-tests/test-visibility*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            },
          }
        )

        await Promise.all([once(childProcess, 'exit'), eventsPromise])
      })

      it('sets final_status tag to test status reported to test framework on last retry (ATR active only)',
        async () => {
          receiver.setSettings({
            itr_enabled: false,
            code_coverage: false,
            tests_skipping: false,
            flaky_test_retries_enabled: true,
            early_flake_detection: { enabled: false },
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              const assertAtrFinalStatus = (testName, expectedFinalStatus) => {
                const group = tests.filter(t => t.meta[TEST_NAME] === testName)
                group.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
                  .forEach((test, index) => {
                    if (index < group.length - 1) {
                      assert.ok(!(TEST_FINAL_STATUS in test.meta),
                        `TEST_FINAL_STATUS should not be set on attempt ${index} of "${testName}"`
                      )
                    } else {
                      assert.strictEqual(test.meta[TEST_FINAL_STATUS], expectedFinalStatus)
                    }
                  })
              }

              // Test that always passes on the first try: final_status is set immediately
              const alwaysPassingTests = tests.filter(
                test => test.meta[TEST_NAME] === 'flaky test retries does not retry if unnecessary'
              )
              assert.strictEqual(alwaysPassingTests.length, 1)
              assert.strictEqual(alwaysPassingTests[0].meta[TEST_FINAL_STATUS], 'pass')

              assertAtrFinalStatus('flaky test retries can retry tests that eventually pass', 'pass')
              assertAtrFinalStatus('flaky test retries can retry tests that never pass', 'fail')

              // With hooks: same behavior
              const alwaysPassingTestsWithHooks = tests.filter(
                test => test.meta[TEST_NAME] === 'flaky test retries with hooks does not retry if unnecessary'
              )
              assert.strictEqual(alwaysPassingTestsWithHooks.length, 1)
              assert.strictEqual(alwaysPassingTestsWithHooks[0].meta[TEST_FINAL_STATUS], 'pass')

              assertAtrFinalStatus('flaky test retries with hooks can retry tests that eventually pass', 'pass')
              assertAtrFinalStatus('flaky test retries with hooks can retry tests that never pass', 'fail')
            })

          childProcess = exec(
            './node_modules/.bin/vitest run',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/{flaky-test-retries,hooks-flaky-test-retries}.mjs',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              },
            }
          )

          await Promise.all([once(childProcess, 'exit'), eventsPromise])
        })

      it('sets final_status tag to test status reported to test framework on last retry (EFD active only)',
        async () => {
          receiver.setKnownTests({
            vitest: {
              'ci-visibility/vitest-tests/early-flake-detection.mjs': [
                'early flake detection does not retry if it is not new',
              ],
              'ci-visibility/vitest-tests/hooks-flaky-test-retries.mjs': [
                'flaky test retries with hooks does not retry if unnecessary',
              ],
            },
          })
          receiver.setSettings({
            early_flake_detection: {
              enabled: true,
              slow_test_retries: { '5s': NUM_RETRIES_EFD },
              faulty_session_threshold: 100,
            },
            known_tests_enabled: true,
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              // Known test: not retried, every execution is already the final one
              const knownTests = tests.filter(
                test => test.meta[TEST_NAME] === 'early flake detection does not retry if it is not new'
              )
              assert.strictEqual(knownTests.length, 1)
              assert.ok(!(TEST_IS_NEW in knownTests[0].meta))
              assert.ok(!(TEST_IS_RETRY in knownTests[0].meta))
              assert.strictEqual(knownTests[0].meta[TEST_FINAL_STATUS], knownTests[0].meta[TEST_STATUS])

              const assertEfdFinalStatus = (testName, expectedFinalStatus) => {
                const group = tests.filter(t => t.meta[TEST_NAME] === testName)
                group.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
                  .forEach((test, index) => {
                    if (index < group.length - 1) {
                      assert.ok(!(TEST_FINAL_STATUS in test.meta))
                    } else {
                      assert.strictEqual(test.meta[TEST_FINAL_STATUS], expectedFinalStatus)
                    }
                  })
              }

              assertEfdFinalStatus('early flake detection can retry tests that eventually pass', 'pass')
              assertEfdFinalStatus('early flake detection can retry tests that always pass', 'pass')

              // With hooks: same behavior
              const knownTestsWithHooks = tests.filter(
                test => test.meta[TEST_NAME] === 'flaky test retries with hooks does not retry if unnecessary'
              )
              assert.strictEqual(knownTestsWithHooks.length, 1)
              assert.ok(!(TEST_IS_NEW in knownTestsWithHooks[0].meta))
              assert.ok(!(TEST_IS_RETRY in knownTestsWithHooks[0].meta))
              assert.strictEqual(
                knownTestsWithHooks[0].meta[TEST_FINAL_STATUS], knownTestsWithHooks[0].meta[TEST_STATUS])

              assertEfdFinalStatus('flaky test retries with hooks can retry tests that eventually pass', 'pass')
              assertEfdFinalStatus('flaky test retries with hooks can retry tests that never pass', 'fail')
            })

          childProcess = exec(
            './node_modules/.bin/vitest run',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/{early-flake-detection,hooks-flaky-test-retries}.mjs',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              },
            }
          )

          await Promise.all([once(childProcess, 'exit'), eventsPromise])
        })

      it('sets final_status tag only on last ATR retry when EFD is enabled but not active and ATR is active',
        async () => {
          // All tests are known so EFD will be enabled but not active for them
          receiver.setKnownTests({
            vitest: {
              'ci-visibility/vitest-tests/flaky-test-retries.mjs': [
                'flaky test retries can retry tests that eventually pass',
                'flaky test retries can retry tests that never pass',
                'flaky test retries does not retry if unnecessary',
              ],
              'ci-visibility/vitest-tests/hooks-flaky-test-retries.mjs': [
                'flaky test retries with hooks can retry tests that eventually pass',
                'flaky test retries with hooks can retry tests that never pass',
                'flaky test retries with hooks does not retry if unnecessary',
              ],
            },
          })
          receiver.setSettings({
            flaky_test_retries_enabled: true,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: { '5s': 3 },
              faulty_session_threshold: 100,
            },
            known_tests_enabled: true,
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              const eventuallyPassingTests = tests.filter(
                test => test.meta[TEST_NAME] === 'flaky test retries can retry tests that eventually pass'
              )
              eventuallyPassingTests.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
                .forEach((test, idx) => {
                  if (idx < eventuallyPassingTests.length - 1) {
                    assert.ok(!(TEST_FINAL_STATUS in test.meta),
                      'TEST_FINAL_STATUS should not be set on previous ATR runs'
                    )
                  } else {
                    assert.strictEqual(test.meta[TEST_FINAL_STATUS], test.meta[TEST_STATUS])
                    assert.strictEqual(test.meta[TEST_STATUS], 'pass')
                  }
                })

              const alwaysPassingTests = tests.filter(
                test => test.meta[TEST_NAME] === 'flaky test retries does not retry if unnecessary'
              )
              assert.strictEqual(alwaysPassingTests.length, 1)
              assert.strictEqual(alwaysPassingTests[0].meta[TEST_FINAL_STATUS], 'pass')

              // With hooks: same behavior
              const eventuallyPassingTestsWithHooks = tests.filter(
                test => test.meta[TEST_NAME] === 'flaky test retries with hooks can retry tests that eventually pass'
              )
              eventuallyPassingTestsWithHooks.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
                .forEach((test, idx) => {
                  if (idx < eventuallyPassingTestsWithHooks.length - 1) {
                    assert.ok(!(TEST_FINAL_STATUS in test.meta),
                      'TEST_FINAL_STATUS should not be set on previous ATR runs'
                    )
                  } else {
                    assert.strictEqual(test.meta[TEST_FINAL_STATUS], test.meta[TEST_STATUS])
                    assert.strictEqual(test.meta[TEST_STATUS], 'pass')
                  }
                })

              const alwaysPassingTestsWithHooks = tests.filter(
                test => test.meta[TEST_NAME] === 'flaky test retries with hooks does not retry if unnecessary'
              )
              assert.strictEqual(alwaysPassingTestsWithHooks.length, 1)
              assert.strictEqual(alwaysPassingTestsWithHooks[0].meta[TEST_FINAL_STATUS], 'pass')
            })

          childProcess = exec(
            './node_modules/.bin/vitest run',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/{flaky-test-retries,hooks-flaky-test-retries}.mjs',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              },
            }
          )

          await Promise.all([once(childProcess, 'exit'), eventsPromise])
        })

      if (version === 'latest') {
        it('sets final_status tag to skip for disabled tests', async () => {
          receiver.setSettings({ test_management: { enabled: true } })
          receiver.setTestManagementTests({
            vitest: {
              suites: {
                'ci-visibility/vitest-tests/test-disabled.mjs': {
                  tests: {
                    'disable tests can disable a test': {
                      properties: { disabled: true },
                    },
                  },
                },
                'ci-visibility/vitest-tests/hooks-test-management.mjs': {
                  tests: {
                    'test management with hooks can apply management to a failing test with hooks': {
                      properties: { disabled: true },
                    },
                  },
                },
              },
            },
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              const disabledTest = tests.find(test => test.meta[TEST_NAME] === 'disable tests can disable a test')
              assert.ok(disabledTest, 'Expected to find the disabled test')
              assert.strictEqual(disabledTest.meta[TEST_STATUS], 'skip')
              assert.strictEqual(disabledTest.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
              assert.strictEqual(disabledTest.meta[TEST_FINAL_STATUS], 'skip')

              // With hooks: same behavior
              const disabledTestWithHooks = tests.find(
                test => test.meta[TEST_NAME] ===
                  'test management with hooks can apply management to a failing test with hooks'
              )
              assert.ok(disabledTestWithHooks, 'Expected to find the disabled test with hooks')
              assert.strictEqual(disabledTestWithHooks.meta[TEST_STATUS], 'skip')
              assert.strictEqual(disabledTestWithHooks.meta[TEST_MANAGEMENT_IS_DISABLED], 'true')
              assert.strictEqual(disabledTestWithHooks.meta[TEST_FINAL_STATUS], 'skip')
            })

          childProcess = exec(
            './node_modules/.bin/vitest run',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/{test-disabled,hooks-test-management}.mjs',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
              },
            }
          )

          await Promise.all([once(childProcess, 'exit'), eventsPromise])
        })

        it('sets final_status tag to skip for quarantined tests', async () => {
          receiver.setSettings({ test_management: { enabled: true } })
          receiver.setTestManagementTests({
            vitest: {
              suites: {
                'ci-visibility/vitest-tests/test-quarantine.mjs': {
                  tests: {
                    'quarantine tests can quarantine a test': {
                      properties: { quarantined: true },
                    },
                    'quarantine tests can quarantine a passing test': {
                      properties: { quarantined: true },
                    },
                  },
                },
                'ci-visibility/vitest-tests/hooks-test-management.mjs': {
                  tests: {
                    'test management with hooks can apply management to a failing test with hooks': {
                      properties: { quarantined: true },
                    },
                  },
                },
                'ci-visibility/vitest-tests/hooks-test-quarantine-failing-after-each.mjs': {
                  tests: {
                    'quarantine tests with failing afterEach can quarantine a test whose afterEach hook fails': {
                      properties: { quarantined: true },
                    },
                  },
                },
              },
            },
          })

          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const tests = events.filter(event => event.type === 'test').map(event => event.content)

              const quarantinedTest = tests.find(
                test => test.meta[TEST_NAME] === 'quarantine tests can quarantine a test'
              )
              assert.ok(quarantinedTest, 'Expected to find the quarantined test')
              // Quarantined test still runs and reports its actual status,
              // but the final status must be 'skip' (errors are suppressed)
              assert.strictEqual(quarantinedTest.meta[TEST_STATUS], 'fail')
              assert.strictEqual(quarantinedTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              assert.strictEqual(quarantinedTest.meta[TEST_FINAL_STATUS], 'skip')

              const passingTest = tests.find(test => test.meta[TEST_NAME] === 'quarantine tests can pass normally')
              assert.ok(passingTest, 'Expected to find the passing test')
              assert.strictEqual(passingTest.meta[TEST_STATUS], 'pass')
              assert.strictEqual(passingTest.meta[TEST_FINAL_STATUS], 'pass')

              // Quarantined test that actually passes must still report final_status=skip
              const quarantinedPassingTest = tests.find(
                test => test.meta[TEST_NAME] === 'quarantine tests can quarantine a passing test'
              )
              assert.ok(quarantinedPassingTest, 'Expected to find the quarantined passing test')
              assert.strictEqual(quarantinedPassingTest.meta[TEST_STATUS], 'pass')
              assert.strictEqual(quarantinedPassingTest.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              assert.strictEqual(quarantinedPassingTest.meta[TEST_FINAL_STATUS], 'skip')

              // With hooks: same behavior
              const quarantinedTestWithHooks = tests.find(
                test => test.meta[TEST_NAME] ===
                  'test management with hooks can apply management to a failing test with hooks'
              )
              assert.ok(quarantinedTestWithHooks, 'Expected to find the quarantined test with hooks')
              assert.strictEqual(quarantinedTestWithHooks.meta[TEST_STATUS], 'fail')
              assert.strictEqual(quarantinedTestWithHooks.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              assert.strictEqual(quarantinedTestWithHooks.meta[TEST_FINAL_STATUS], 'skip')

              const passingTestWithHooks = tests.find(
                test => test.meta[TEST_NAME] === 'test management with hooks can pass normally with hooks'
              )
              assert.ok(passingTestWithHooks, 'Expected to find the passing test with hooks')
              assert.strictEqual(passingTestWithHooks.meta[TEST_STATUS], 'pass')
              assert.strictEqual(passingTestWithHooks.meta[TEST_FINAL_STATUS], 'pass')

              // With hooks where afterEach throws: test body passes but hook causes failure — still skip
              const quarantinedTestFailingAfterEach = tests.find(
                test => test.meta[TEST_NAME] ===
                  'quarantine tests with failing afterEach can quarantine a test whose afterEach hook fails'
              )
              assert.ok(quarantinedTestFailingAfterEach, 'Expected to find the quarantined test with failing afterEach')
              assert.strictEqual(quarantinedTestFailingAfterEach.meta[TEST_STATUS], 'fail')
              assert.strictEqual(quarantinedTestFailingAfterEach.meta[TEST_MANAGEMENT_IS_QUARANTINED], 'true')
              assert.strictEqual(quarantinedTestFailingAfterEach.meta[TEST_FINAL_STATUS], 'skip')
            })

          childProcess = exec(
            './node_modules/.bin/vitest run',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                TEST_DIR: 'ci-visibility/vitest-tests/' +
                  '{test-quarantine,hooks-test-management,hooks-test-quarantine-failing-after-each}.mjs',
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init --no-warnings',
              },
            }
          )

          await Promise.all([once(childProcess, 'exit'), eventsPromise])
        })
      }
    })
  })
})
