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

// should probably work with 1.6.0
// tested with 1.1.0
const versions = ['1.1.0'] // only one I've tested so far

versions.forEach((version) => {
  describe(`vitest@${version}`, () => {
    let sandbox, cwd, receiver, childProcess

    before(async function () {
      sandbox = await createSandbox([`vitest@${version}`], true)
      // debugger
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
        debugger
        const events = payloads.flatMap(({ payload }) => payload.events)

        const testSessionEvent = events.find(event => event.type === 'test_session_end')
        const testModuleEvent = events.find(event => event.type === 'test_module_end')
        const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
        const testEvents = events.filter(event => event.type === 'test')

        assert.include(testSessionEvent.content.resource, 'test_session.vitest run')
        assert.equal(testSessionEvent.content.meta[TEST_STATUS], 'pass')
        assert.include(testModuleEvent.content.resource, 'test_module.vitest run')
        assert.equal(testModuleEvent.content.meta[TEST_STATUS], 'pass')
        assert.equal(testSessionEvent.content.meta[TEST_TYPE], 'test')
        assert.equal(testModuleEvent.content.meta[TEST_TYPE], 'test')

        assert.includeMembers(testSuiteEvents.map(suite => suite.content.resource), [
          'test_suite.ci-visibility/vitest-tests/test-visibility-test.mjs',
          'test_suite.ci-visibility/vitest-tests/test-visibility-test-2.mjs'
        ])

        // TODO: just check pass
        assert.includeMembers(testSuiteEvents.map(suite => suite.content.meta[TEST_STATUS]), [
          'pass',
        ])


        assert.includeMembers(testEvents.map(test => test.content.resource), [
          'ci-visibility/vitest-tests/test-visibility-test.mjs.can report tests',
          'ci-visibility/vitest-tests/test-visibility-test-2.mjs.can report tests 2',
        ])

        // TODO: just check pass
        assert.includeMembers(testEvents.map(test => test.content.meta[TEST_STATUS]), [
          'pass',
        ])
      }).then(() => done()).catch(done)

      childProcess = exec(
        './node_modules/.bin/vitest run',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            // maybe only in node@20
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init', // ESM requires more stuff
          },
          stdio: 'pipe'
        }
      )

      childProcess.stdout.pipe(process.stdout)
      childProcess.stderr.pipe(process.stderr)
    })
  })
})
