'use strict'

const { exec } = require('child_process')

const getPort = require('get-port')
const { assert } = require('chai')

const {
  createSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig
} = require('./helpers')
const { FakeCiVisIntake } = require('./ci-visibility-intake')
const { TEST_STATUS } = require('../packages/dd-trace/src/plugins/util/test')

describe('cucumber', () => {
  let sandbox, cwd, receiver, childProcess
  before(async () => {
    sandbox = await createSandbox(['@cucumber/cucumber', 'assert'], true)
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

          assert.equal(testSessionEvent.content.resource, 'test_session.cucumber-js')
          assert.equal(testSessionEvent.content.meta[TEST_STATUS], 'fail')
          assert.equal(testModuleEvent.content.resource, 'test_module.cucumber-js')
          assert.equal(testModuleEvent.content.meta[TEST_STATUS], 'fail')

          assert.includeMembers(testSuiteEvents.map(suite => suite.content.resource), [
            'test_suite.ci-visibility/features/farewell.feature',
            'test_suite.ci-visibility/features/greetings.feature'
          ])

          assert.includeMembers(testSuiteEvents.map(suite => suite.content.meta[TEST_STATUS]), [
            'pass',
            'fail'
          ])

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
