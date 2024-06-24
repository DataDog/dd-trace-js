'use strict'

const { exec } = require('child_process')

const getPort = require('get-port')
const { assert } = require('chai')

const {
  createSandbox,
  getCiVisAgentlessConfig
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  TEST_STATUS,
  TEST_TYPE
} = require('../../packages/dd-trace/src/plugins/util/test')

// tested with 1.6.0
const versions = ['latest']

versions.forEach((version) => {
  describe(`vitest@${version}`, () => {
    let sandbox, cwd, receiver, childProcess

    before(async function () {
      sandbox = await createSandbox([`vitest@${version}`], true)
      cwd = sandbox.folder
    })

    after(async () => {
      await sandbox.remove()
    })

    beforeEach(async function () {
      const port = await getPort()
      receiver = await new FakeCiVisIntake(port).start()
    })

    afterEach(async () => {
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

        assert.include(testSessionEvent.content.resource, 'test_session.vitest run')
        assert.equal(testSessionEvent.content.meta[TEST_STATUS], 'fail')
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
            'ci-visibility/vitest-tests/test-visibility-failed-hooks.mjs.other context can report more'
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
        // TODO: check error messages
      }).then(() => done()).catch(done)

      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            // maybe only in node@20
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init' // ESM requires more flags
          },
          stdio: 'pipe'
        }
      )

      childProcess.stderr.pipe(process.stderr)
      childProcess.stdout.pipe(process.stdout)
    })
  })
})
