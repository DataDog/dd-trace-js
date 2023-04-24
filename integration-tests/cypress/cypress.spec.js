'use strict'

const { exec } = require('child_process')

const getPort = require('get-port')
const { assert } = require('chai')
const semver = require('semver')

const {
  createSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const webAppServer = require('../ci-visibility/web-app-server')
const {
  TEST_STATUS,
  TEST_COMMAND,
  TEST_MODULE,
  TEST_FRAMEWORK_VERSION,
  TEST_TOOLCHAIN
} = require('../../packages/dd-trace/src/plugins/util/test')

// TODO: remove when 2.x support is removed.
// This is done because from playwright@>=1.22.0 node 12 is not supported
const isOldNode = semver.satisfies(process.version, '<=12')
const versions = ['6.7.0', isOldNode ? '11.2.0' : 'latest']

versions.forEach((version) => {
  describe(`cypress@${version}`, function () {
    this.retries(2)
    this.timeout(60000)
    let sandbox, cwd, receiver, childProcess, webAppPort
    before(async () => {
      sandbox = await createSandbox([`cypress@${version}`], true)
      cwd = sandbox.folder
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

          receiver.gatherPayloadsMaxTimeout(({ url }) => url === reportUrl, payloads => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const testSessionEvent = events.find(event => event.type === 'test_session_end')
            const testModuleEvent = events.find(event => event.type === 'test_module_end')
            const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
            const testEvents = events.filter(event => event.type === 'test')

            const { content: testSessionEventContent } = testSessionEvent
            const { content: testModuleEventContent } = testModuleEvent

            assert.exists(testSessionEventContent.test_session_id)
            assert.exists(testSessionEventContent.meta[TEST_COMMAND])
            assert.exists(testSessionEventContent.meta[TEST_TOOLCHAIN])
            assert.equal(testSessionEventContent.resource.startsWith('test_session.'), true)
            assert.equal(testSessionEventContent.meta[TEST_STATUS], 'fail')

            assert.exists(testModuleEventContent.test_session_id)
            assert.exists(testModuleEventContent.test_module_id)
            assert.exists(testModuleEventContent.meta[TEST_COMMAND])
            assert.exists(testModuleEventContent.meta[TEST_MODULE])
            assert.equal(testModuleEventContent.resource.startsWith('test_module.'), true)
            assert.equal(testModuleEventContent.meta[TEST_STATUS], 'fail')
            assert.equal(
              testModuleEventContent.test_session_id.toString(10),
              testSessionEventContent.test_session_id.toString(10)
            )
            assert.exists(testModuleEventContent.meta[TEST_FRAMEWORK_VERSION])

            assert.includeMembers(testSuiteEvents.map(suite => suite.content.resource), [
              'test_suite.cypress/e2e/other.cy.js',
              'test_suite.cypress/e2e/spec.cy.js'
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
              assert.exists(meta[TEST_MODULE])
              assert.exists(testSuiteId)
              assert.equal(testModuleId.toString(10), testModuleEventContent.test_module_id.toString(10))
              assert.equal(testSessionId.toString(10), testSessionEventContent.test_session_id.toString(10))
            })

            assert.includeMembers(testEvents.map(test => test.content.resource), [
              'cypress/e2e/other.cy.js.context passes',
              'cypress/e2e/spec.cy.js.context passes',
              'cypress/e2e/spec.cy.js.other context fails'
            ])

            assert.includeMembers(testEvents.map(test => test.content.meta[TEST_STATUS]), [
              'pass',
              'pass',
              'fail'
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
              assert.exists(meta[TEST_MODULE])
              assert.exists(testSuiteId)
              assert.equal(testModuleId.toString(10), testModuleEventContent.test_module_id.toString(10))
              assert.equal(testSessionId.toString(10), testSessionEventContent.test_session_id.toString(10))
            })
          }, 25000).then(() => done()).catch(done)

          const {
            NODE_OPTIONS, // NODE_OPTIONS dd-trace config does not work with cypress
            ...restEnvVars
          } = envVars

          const commandSuffix = version === '6.7.0' ? '--config-file cypress-config.json' : ''

          childProcess = exec(
            `./node_modules/.bin/cypress run --quiet ${commandSuffix}`,
            {
              cwd,
              env: {
                ...restEnvVars,
                CYPRESS_BASE_URL: `http://localhost:${webAppPort}`
              },
              stdio: 'pipe'
            }
          )
        })
      })
    })
  })
})
