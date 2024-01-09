'use strict'

const { exec, execSync } = require('child_process')

const getPort = require('get-port')
const { assert } = require('chai')

const {
  createSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const webAppServer = require('../ci-visibility/web-app-server')
const { TEST_STATUS, TEST_SOURCE_START, TEST_TYPE } = require('../../packages/dd-trace/src/plugins/util/test')

const versions = ['1.18.0', 'latest']

versions.forEach((version) => {
  describe(`playwright@${version}`, () => {
    let sandbox, cwd, receiver, childProcess, webAppPort
    before(async function () {
      // bump from 30 to 60 seconds because playwright dependencies are heavy
      this.timeout(60000)
      sandbox = await createSandbox([`@playwright/test@${version}`, 'typescript'], true)
      cwd = sandbox.folder
      // install necessary browser
      const { NODE_OPTIONS, ...restOfEnv } = process.env
      execSync('npx playwright install', { cwd, env: restOfEnv })
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

            const stepEvents = events.filter(event => event.type === 'span')

            assert.include(testSessionEvent.content.resource, 'test_session.playwright test')
            assert.equal(testSessionEvent.content.meta[TEST_STATUS], 'fail')
            assert.include(testModuleEvent.content.resource, 'test_module.playwright test')
            assert.equal(testModuleEvent.content.meta[TEST_STATUS], 'fail')
            assert.equal(testSessionEvent.content.meta[TEST_TYPE], 'browser')
            assert.equal(testModuleEvent.content.meta[TEST_TYPE], 'browser')
            assert.includeMembers(testSuiteEvents.map(suite => suite.content.resource), [
              'test_suite.todo-list-page-test.js',
              'test_suite.landing-page-test.js',
              'test_suite.skipped-suite-test.js'
            ])

            assert.includeMembers(testSuiteEvents.map(suite => suite.content.meta[TEST_STATUS]), [
              'pass',
              'fail',
              'skip'
            ])

            assert.includeMembers(testEvents.map(test => test.content.resource), [
              'landing-page-test.js.should work with passing tests',
              'landing-page-test.js.should work with skipped tests',
              'landing-page-test.js.should work with fixme',
              'landing-page-test.js.should work with annotated tests',
              'todo-list-page-test.js.should work with failing tests',
              'todo-list-page-test.js.should work with fixme root'
            ])

            assert.includeMembers(testEvents.map(test => test.content.meta[TEST_STATUS]), [
              'pass',
              'fail',
              'skip'
            ])

            testEvents.forEach(testEvent => {
              assert.exists(testEvent.content.metrics[TEST_SOURCE_START])
            })

            stepEvents.forEach(stepEvent => {
              assert.equal(stepEvent.content.name, 'playwright.step')
              assert.property(stepEvent.content.meta, 'playwright.step')
            })
            const annotatedTest = testEvents.find(test =>
              test.content.resource === 'landing-page-test.js.should work with annotated tests'
            )

            assert.propertyVal(annotatedTest.content.meta, 'test.memory.usage', 'low')
            assert.propertyVal(annotatedTest.content.metrics, 'test.memory.allocations', 16)
            assert.notProperty(annotatedTest.content.meta, 'test.invalid')
          }).then(() => done()).catch(done)

          childProcess = exec(
            './node_modules/.bin/playwright test -c playwright.config.js',
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
    it('works when tests are compiled to a different location', (done) => {
      let testOutput = ''

      receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcycle', payloads => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testEvents = events.filter(event => event.type === 'test')
        assert.includeMembers(testEvents.map(test => test.content.resource), [
          'playwright-tests-ts/one-test.js.should work with passing tests',
          'playwright-tests-ts/one-test.js.should work with skipped tests'
        ])
        assert.include(testOutput, '1 passed')
        assert.include(testOutput, '1 skipped')
        assert.notInclude(testOutput, 'TypeError')
      }).then(() => done()).catch(done)

      childProcess = exec(
        'node ./node_modules/typescript/bin/tsc' +
        '&& ./node_modules/.bin/playwright test -c ci-visibility/playwright-tests-ts-out',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            PW_BASE_URL: `http://localhost:${webAppPort}`,
            PW_RUNNER_DEBUG: '1'
          },
          stdio: 'inherit'
        }
      )
      childProcess.stdout.on('data', chunk => {
        testOutput += chunk.toString()
      })
      childProcess.stderr.on('data', chunk => {
        testOutput += chunk.toString()
      })
    })
  })
})
