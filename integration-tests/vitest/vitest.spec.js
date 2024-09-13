'use strict'

const { exec } = require('child_process')

const { assert } = require('chai')

const {
  createSandbox,
  getCiVisAgentlessConfig
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  TEST_STATUS,
  TEST_TYPE,
  TEST_IS_RETRY,
  TEST_CODE_OWNERS,
  TEST_CODE_COVERAGE_LINES_PCT,
  TEST_SESSION_NAME,
  TEST_COMMAND,
  TEST_SOURCE_FILE,
  TEST_SOURCE_START
} = require('../../packages/dd-trace/src/plugins/util/test')

const versions = ['1.6.0', 'latest']

const linePctMatchRegex = /Lines\s+:\s+([\d.]+)%/

versions.forEach((version) => {
  describe(`vitest@${version}`, () => {
    let sandbox, cwd, receiver, childProcess, testOutput

    before(async function () {
      sandbox = await createSandbox([
        `vitest@${version}`,
        `@vitest/coverage-istanbul@${version}`,
        `@vitest/coverage-v8@${version}`
      ], true)
      cwd = sandbox.folder
    })

    after(async () => {
      await sandbox.remove()
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      testOutput = ''
      childProcess.kill()
      await receiver.stop()
    })

    it('can run and report tests', (done) => {
      receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
        const events = payloads.flatMap(({ payload }) => payload.events)

        const testSessionEvent = events.find(event => event.type === 'test_session_end')
        const testModuleEvent = events.find(event => event.type === 'test_module_end')
        const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
        const testEvents = events.filter(event => event.type === 'test')

        assert.equal(testSessionEvent.content.meta[TEST_SESSION_NAME], 'my-test-session')
        assert.include(testSessionEvent.content.resource, 'test_session.vitest run')
        assert.equal(testSessionEvent.content.meta[TEST_STATUS], 'fail')
        assert.equal(testModuleEvent.content.meta[TEST_SESSION_NAME], 'my-test-session')
        assert.include(testModuleEvent.content.resource, 'test_module.vitest run')
        assert.equal(testModuleEvent.content.meta[TEST_STATUS], 'fail')
        assert.equal(testSessionEvent.content.meta[TEST_TYPE], 'test')
        assert.equal(testModuleEvent.content.meta[TEST_TYPE], 'test')

        const passedSuite = testSuiteEvents.find(
          suite => suite.content.resource === 'test_suite.ci-visibility/vitest-tests/test-visibility-passed-suite.mjs'
        )
        assert.equal(passedSuite.content.meta[TEST_STATUS], 'pass')

        const failedSuite = testSuiteEvents.find(
          suite => suite.content.resource === 'test_suite.ci-visibility/vitest-tests/test-visibility-failed-suite.mjs'
        )
        assert.equal(failedSuite.content.meta[TEST_STATUS], 'fail')

        const failedSuiteHooks = testSuiteEvents.find(
          suite => suite.content.resource === 'test_suite.ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs'
        )
        assert.equal(failedSuiteHooks.content.meta[TEST_STATUS], 'fail')

        assert.includeMembers(testEvents.map(test => test.content.resource),
          [
            'ci-visibility/vitest-tests/test-visibility-failed-suite.mjs' +
            '.test-visibility-failed-suite-first-describe can report failed test',
            'ci-visibility/vitest-tests/test-visibility-failed-suite.mjs' +
            '.test-visibility-failed-suite-first-describe can report more',
            'ci-visibility/vitest-tests/test-visibility-failed-suite.mjs' +
            '.test-visibility-failed-suite-second-describe can report passed test',
            'ci-visibility/vitest-tests/test-visibility-failed-suite.mjs' +
            '.test-visibility-failed-suite-second-describe can report more',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.context can report passed test',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.context can report more',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can report passed test',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can report more',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can skip',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can todo',
            'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.context can report failed test',
            'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.context can report more',
            'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.other context can report passed test',
            'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.other context can report more',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.no suite',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.skip no suite',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.programmatic skip no suite'
          ]
        )

        const failedTests = testEvents.filter(test => test.content.meta[TEST_STATUS] === 'fail')

        assert.includeMembers(
          failedTests.map(test => test.content.resource),
          [
            'ci-visibility/vitest-tests/test-visibility-failed-suite.mjs' +
            '.test-visibility-failed-suite-first-describe can report failed test',
            'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.context can report failed test',
            'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.context can report more',
            'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.other context can report passed test',
            'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.other context can report more'
          ]
        )

        const skippedTests = testEvents.filter(test => test.content.meta[TEST_STATUS] === 'skip')

        assert.includeMembers(
          skippedTests.map(test => test.content.resource),
          [
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can skip',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can todo',
            'ci-visibility/vitest-tests/test-visibility-passed-suite.mjs.other context can programmatic skip'
          ]
        )

        testEvents.forEach(test => {
          assert.equal(test.content.meta[TEST_SESSION_NAME], 'my-test-session')
          assert.equal(test.content.meta[TEST_COMMAND], 'vitest run')
        })

        testSuiteEvents.forEach(testSuite => {
          assert.equal(testSuite.content.meta[TEST_SESSION_NAME], 'my-test-session')
          assert.equal(testSuite.content.meta[TEST_COMMAND], 'vitest run')
          assert.isTrue(
            testSuite.content.meta[TEST_SOURCE_FILE].startsWith('ci-visibility/vitest-tests/test-visibility')
          )
          assert.equal(testSuite.content.metrics[TEST_SOURCE_START], 1)
        })
        // TODO: check error messages
      }).then(() => done()).catch(done)

      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
            DD_SESSION_NAME: 'my-test-session'
          },
          stdio: 'pipe'
        }
      )
    })

    context('flaky test retries', () => {
      it('can retry flaky tests', (done) => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false
          }
        })

        receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testEvents = events.filter(event => event.type === 'test')
          assert.equal(testEvents.length, 11)
          assert.includeMembers(testEvents.map(test => test.content.resource), [
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            // passes at the third retry
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            // never passes
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            // passes on the first try
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries does not retry if unnecessary'
          ])
          const eventuallyPassingTest = testEvents.filter(
            test => test.content.resource ===
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass'
          )
          assert.equal(eventuallyPassingTest.length, 4)
          assert.equal(eventuallyPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'fail').length, 3)
          assert.equal(eventuallyPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'pass').length, 1)
          assert.equal(eventuallyPassingTest.filter(test => test.content.meta[TEST_IS_RETRY] === 'true').length, 3)

          const neverPassingTest = testEvents.filter(
            test => test.content.resource ===
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass'
          )
          assert.equal(neverPassingTest.length, 6)
          assert.equal(neverPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'fail').length, 6)
          assert.equal(neverPassingTest.filter(test => test.content.meta[TEST_STATUS] === 'pass').length, 0)
          assert.equal(neverPassingTest.filter(test => test.content.meta[TEST_IS_RETRY] === 'true').length, 5)
        }).then(() => done()).catch(done)

        childProcess = exec(
          './node_modules/.bin/vitest run', // TODO: change tests we run
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/flaky-test-retries*',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init' // ESM requires more flags
            },
            stdio: 'pipe'
          }
        )
      })

      it('is disabled if DD_CIVISIBILITY_FLAKY_RETRY_ENABLED is false', (done) => {
        receiver.setSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
          flaky_test_retries_enabled: true,
          early_flake_detection: {
            enabled: false
          }
        })

        receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testEvents = events.filter(event => event.type === 'test')
          assert.equal(testEvents.length, 3)
          assert.includeMembers(testEvents.map(test => test.content.resource), [
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries does not retry if unnecessary'
          ])
          assert.equal(testEvents.filter(test => test.content.meta[TEST_IS_RETRY] === 'true').length, 0)
        }).then(() => done()).catch(done)

        childProcess = exec(
          './node_modules/.bin/vitest run', // TODO: change tests we run
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/flaky-test-retries*',
              DD_CIVISIBILITY_FLAKY_RETRY_ENABLED: 'false',
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init' // ESM requires more flags
            },
            stdio: 'pipe'
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
            enabled: false
          }
        })

        receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const testEvents = events.filter(event => event.type === 'test')
          assert.equal(testEvents.length, 5)
          assert.includeMembers(testEvents.map(test => test.content.resource), [
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that eventually pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries can retry tests that never pass',
            'ci-visibility/vitest-tests/flaky-test-retries.mjs.flaky test retries does not retry if unnecessary'
          ])
          assert.equal(testEvents.filter(test => test.content.meta[TEST_IS_RETRY] === 'true').length, 2)
        }).then(() => done()).catch(done)

        childProcess = exec(
          './node_modules/.bin/vitest run', // TODO: change tests we run
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              TEST_DIR: 'ci-visibility/vitest-tests/flaky-test-retries*',
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: 1,
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init' // ESM requires more flags
            },
            stdio: 'pipe'
          }
        )
      })
    })

    it('correctly calculates test code owners when working directory is not repository root', (done) => {
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const test = events.find(event => event.type === 'test').content
          const testSuite = events.find(event => event.type === 'test_suite_end').content
          assert.equal(test.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
          assert.equal(testSuite.meta[TEST_CODE_OWNERS], JSON.stringify(['@datadog-dd-trace-js']))
        })

      childProcess = exec(
        '../../node_modules/.bin/vitest run',
        {
          cwd: `${cwd}/ci-visibility/subproject`,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more flags
            TEST_DIR: './vitest-test.mjs'
          },
          stdio: 'inherit'
        }
      )

      childProcess.stdout.pipe(process.stdout)
      childProcess.stderr.pipe(process.stderr)

      childProcess.on('exit', () => {
        eventsPromise.then(() => {
          done()
        }).catch(done)
      })
    })

    // only works for >=2.0.0
    if (version === 'latest') {
      const coverageProviders = ['v8', 'istanbul']

      coverageProviders.forEach((coverageProvider) => {
        it(`reports code coverage for ${coverageProvider} provider`, (done) => {
          let codeCoverageExtracted
          const eventsPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)

              const testSession = events.find(event => event.type === 'test_session_end').content

              codeCoverageExtracted = testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT]
            })

          childProcess = exec(
            './node_modules/.bin/vitest run --coverage',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
                COVERAGE_PROVIDER: coverageProvider,
                TEST_DIR: 'ci-visibility/vitest-tests/coverage-test*'
              },
              stdio: 'inherit'
            }
          )

          childProcess.stdout.on('data', (chunk) => {
            testOutput += chunk.toString()
          })
          childProcess.stderr.on('data', (chunk) => {
            testOutput += chunk.toString()
          })

          childProcess.on('exit', () => {
            eventsPromise.then(() => {
              const linePctMatch = testOutput.match(linePctMatchRegex)
              const linesPctFromNyc = linePctMatch ? Number(linePctMatch[1]) : null

              assert.equal(
                linesPctFromNyc,
                codeCoverageExtracted,
                'coverage reported by vitest does not match extracted coverage'
              )
              done()
            }).catch(done)
          })
        })
      })
    }
  })
})
