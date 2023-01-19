'use strict'

const { exec, execSync } = require('child_process')

const getPort = require('get-port')
const { assert } = require('chai')

const {
  createSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig
} = require('./helpers')
const { FakeCiVisIntake } = require('./ci-visibility-intake')

describe('playwright', () => {
  let sandbox, cwd, testCommand, receiver, childProcess
  before(async () => {
    sandbox = await createSandbox(['@playwright/test'], true)
    cwd = sandbox.folder
    // install necessary browser
    await execSync('npx playwright install', { cwd })
    testCommand = './node_modules/.bin/playwright test'
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
        const reportUrl = reportMethod === 'agentless' ? '/api/v2/citestcycle' : '/evp_proxy/v2/api/v2/citestcycle'

        receiver.payloadReceived(({ url }) => url === reportUrl).then(({ payload }) => {
          const testSessionEvent = payload.events.find(event => event.type === 'test_session_end')
          const testModuleEvent = payload.events.find(event => event.type === 'test_module_end')
          const testSuiteEvent = payload.events.find(event => event.type === 'test_suite_end')
          const testEvent = payload.events.find(event => event.type === 'test')

          const stepEvents = payload.events.filter(event => event.type === 'span')

          assert.equal(testSessionEvent.content.resource, 'test_session.playwright test')
          assert.equal(testModuleEvent.content.resource, 'test_module.playwright test')
          assert.equal(testSuiteEvent.content.resource, 'test_suite.ci-visibility/playwright-tests/landing-test.js')
          assert.equal(
            testEvent.content.resource,
            'ci-visibility/playwright-tests/landing-test.js.should allow me to add todo items'
          )

          stepEvents.forEach(stepEvent => {
            assert.equal(stepEvent.content.name, 'playwright.step')
            assert.property(stepEvent.content.meta, 'playwright.step')
          })

          done()
        }).catch(done)

        childProcess = exec(
          testCommand,
          {
            cwd,
            env: reportMethod === 'agentless'
              ? getCiVisAgentlessConfig(receiver.port) : getCiVisEvpProxyConfig(receiver.port),
            stdio: 'pipe'
          }
        )
      })
    })
  })
})
