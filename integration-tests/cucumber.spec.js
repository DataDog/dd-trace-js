'use strict'

const { exec } = require('child_process')

const getPort = require('get-port')
const semver = require('semver')
const { assert } = require('chai')

const {
  createSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig
} = require('./helpers')
const { FakeCiVisIntake } = require('./ci-visibility-intake')
const { TEST_STATUS, TEST_COMMAND, TEST_BUNDLE } = require('../packages/dd-trace/src/plugins/util/test')

const isOldNode = semver.satisfies(process.version, '<=12')
const versions = ['7.0.0', isOldNode ? '8' : 'latest']

versions.forEach(version => {
  describe(`cucumber@${version}`, () => {
    let sandbox, cwd, receiver, childProcess
    before(async () => {
      sandbox = await createSandbox([`@cucumber/cucumber@${version}`, 'assert'], true)
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
    const reportMethods = ['agentless', 'evp proxy']

    reportMethods.forEach((reportMethod) => {
      context(`reporting via ${reportMethod}`, () => {
        it('can run and report tests', (done) => {
          const envVars = reportMethod === 'agentless'
            ? getCiVisAgentlessConfig(receiver.port) : getCiVisEvpProxyConfig(receiver.port)
          const reportUrl = reportMethod === 'agentless' ? '/api/v2/citestcycle' : '/evp_proxy/v2/api/v2/citestcycle'

          receiver.gatherPayloads(({ url }) => url === reportUrl, 5000).then((payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSessionEvent = events.find(event => event.type === 'test_session_end')
            const testModuleEvent = events.find(event => event.type === 'test_module_end')
            const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
            const testEvents = events.filter(event => event.type === 'test')

            const stepEvents = events.filter(event => event.type === 'span')

            const { content: testSessionEventContent } = testSessionEvent
            const { content: testModuleEventContent } = testModuleEvent

            assert.exists(testSessionEventContent.test_session_id)
            assert.exists(testModuleEventContent.meta[TEST_COMMAND])
            assert.equal(testSessionEventContent.resource.startsWith('test_session.'), true)
            assert.equal(testSessionEventContent.meta[TEST_STATUS], 'fail')

            assert.exists(testModuleEventContent.test_session_id)
            assert.exists(testModuleEventContent.test_module_id)
            assert.exists(testModuleEventContent.meta[TEST_COMMAND])
            assert.exists(testModuleEventContent.meta[TEST_BUNDLE])
            assert.equal(testModuleEventContent.resource.startsWith('test_module.'), true)
            assert.equal(testModuleEventContent.meta[TEST_STATUS], 'fail')
            assert.equal(
              testModuleEventContent.test_session_id.toString(10),
              testSessionEventContent.test_session_id.toString(10)
            )

            assert.includeMembers(testSuiteEvents.map(suite => suite.content.resource), [
              'test_suite.ci-visibility/features/farewell.feature',
              'test_suite.ci-visibility/features/greetings.feature'
            ])
            assert.includeMembers(testSuiteEvents.map(suite => suite.content.meta[TEST_STATUS]), [
              'pass',
              'fail'
            ])

            testSuiteEvents.forEach(({
              content: {
                meta,
                test_suite_id: testSuiteId,
                test_module_id: testModuleId,
                test_session_id: testSessionId
              }
            }) => {
              assert.exists(meta[TEST_COMMAND])
              assert.exists(meta[TEST_BUNDLE])
              assert.exists(testSuiteId)
              assert.equal(testModuleId.toString(10), testModuleEventContent.test_module_id.toString(10))
              assert.equal(testSessionId.toString(10), testSessionEventContent.test_session_id.toString(10))
            })

            assert.includeMembers(testEvents.map(test => test.content.resource), [
              'ci-visibility/features/farewell.feature.Say farewell',
              'ci-visibility/features/greetings.feature.Say greetings',
              'ci-visibility/features/greetings.feature.Say yeah',
              'ci-visibility/features/greetings.feature.Say yo',
              'ci-visibility/features/greetings.feature.Say skip'
            ])
            assert.includeMembers(testEvents.map(test => test.content.meta[TEST_STATUS]), [
              'pass',
              'pass',
              'pass',
              'fail',
              'skip'
            ])

            testEvents.forEach(({
              content: {
                meta,
                test_suite_id: testSuiteId,
                test_module_id: testModuleId,
                test_session_id: testSessionId
              }
            }) => {
              assert.exists(meta[TEST_COMMAND])
              assert.exists(meta[TEST_BUNDLE])
              assert.exists(testSuiteId)
              assert.equal(testModuleId.toString(10), testModuleEventContent.test_module_id.toString(10))
              assert.equal(testSessionId.toString(10), testSessionEventContent.test_session_id.toString(10))
            })

            stepEvents.forEach(stepEvent => {
              assert.equal(stepEvent.content.name, 'cucumber.step')
              assert.property(stepEvent.content.meta, 'cucumber.step')
            })

            done()
          }).catch(done)

          childProcess = exec(
            './node_modules/.bin/cucumber-js ci-visibility/features/*.feature',
            {
              cwd,
              env: envVars,
              stdio: 'pipe'
            }
          )
        })
      })
    })
  })
})
