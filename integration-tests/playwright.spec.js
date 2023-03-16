'use strict'

const { exec, execSync } = require('child_process')

const getPort = require('get-port')
const { assert } = require('chai')
const semver = require('semver')

const {
  createSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig
} = require('./helpers')
const { FakeCiVisIntake } = require('./ci-visibility-intake')
const webAppServer = require('./ci-visibility/web-app-server')
const { TEST_STATUS } = require('../packages/dd-trace/src/plugins/util/test')

// TODO: remove when 2.x support is removed.
// This is done because from playwright@>=1.22.0 node 12 is not supported
// TODO: figure out why playwright 1.31.0 fails
const isOldNode = semver.satisfies(process.version, '<=12')
const versions = ['1.18.0', isOldNode ? '1.21.0' : 'latest']

versions.forEach((version) => {
  describe(`playwright@${version}`, () => {
    let sandbox, cwd, receiver, childProcess, webAppPort
    before(async function () {
      // bump from 30 to 60 seconds because playwright dependencies are heavy
      this.timeout(60000)
      sandbox = await createSandbox([`@playwright/test@${version}`], true)
      cwd = sandbox.folder
      // install necessary browser
      execSync('npx playwright install', { cwd })
      webAppPort = await getPort()
      webAppServer.listen(webAppPort)
    })

    after(async () => {
      await sandbox.remove()
      await new Promise(resolve => webAppServer.close(resolve))
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

          receiver.gatherPayloads(({ url }) => url === reportUrl).then((payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSessionEvent = events.find(event => event.type === 'test_session_end')
            const testModuleEvent = events.find(event => event.type === 'test_module_end')
            const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
            const testEvents = events.filter(event => event.type === 'test')

            const stepEvents = events.filter(event => event.type === 'span')

            assert.equal(testSessionEvent.content.resource, 'test_session.playwright test')
            assert.equal(testSessionEvent.content.meta[TEST_STATUS], 'fail')
            assert.equal(testModuleEvent.content.resource, 'test_module.playwright test')
            assert.equal(testModuleEvent.content.meta[TEST_STATUS], 'fail')

            assert.includeMembers(testSuiteEvents.map(suite => suite.content.resource), [
              'test_suite.todo-list-page-test.js',
              'test_suite.landing-page-test.js'
            ])

            assert.includeMembers(testSuiteEvents.map(suite => suite.content.meta[TEST_STATUS]), [
              'pass',
              'fail'
            ])

            assert.includeMembers(testEvents.map(test => test.content.resource), [
              'landing-page-test.js.should work with passing tests',
              'landing-page-test.js.should work with skipped tests',
              'todo-list-page-test.js.should work with failing tests'
            ])

            assert.includeMembers(testEvents.map(test => test.content.meta[TEST_STATUS]), [
              'pass',
              'fail',
              'skip'
            ])

            stepEvents.forEach(stepEvent => {
              assert.equal(stepEvent.content.name, 'playwright.step')
              assert.property(stepEvent.content.meta, 'playwright.step')
            })

            done()
          }).catch(done)

          childProcess = exec(
            './node_modules/.bin/playwright test',
            {
              cwd,
              env: {
                ...envVars,
                PW_BASE_URL: `http://localhost:${webAppPort}`
              },
              stdio: 'pipe'
            }
          )
        })
      })
    })
  })
})
