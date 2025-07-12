'use strict'

const { exec } = require('child_process')

const { assert } = require('chai')

const {
  createSandbox,
  getCiVisAgentlessConfig
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  TEST_BROWSER_DRIVER,
  TEST_BROWSER_NAME,
  TEST_BROWSER_VERSION,
  TEST_BROWSER_DRIVER_VERSION,
  TEST_IS_RUM_ACTIVE,
  TEST_TYPE
} = require('../../packages/dd-trace/src/plugins/util/test')

const webAppServer = require('../ci-visibility/web-app-server')

const versionRange = ['4.11.0', 'latest']

versionRange.forEach(version => {
  describe(`selenium ${version}`, () => {
    let receiver
    let childProcess
    let sandbox
    let cwd
    let webAppPort

    before(async function () {
      sandbox = await createSandbox([
        'mocha',
        'jest',
        '@cucumber/cucumber',
        'chai@v4',
        `selenium-webdriver@${version}`
      ])
      cwd = sandbox.folder

      webAppServer.listen(0, () => {
        webAppPort = webAppServer.address().port
      })
    })

    after(async function () {
      await sandbox.remove()
      await new Promise(resolve => webAppServer.close(resolve))
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      childProcess.kill()
      await receiver.stop()
    })

    const testFrameworks = [
      {
        name: 'mocha',
        command: 'mocha ./ci-visibility/test/selenium-test.js --timeout 10000'
      },
      {
        name: 'jest',
        command: 'node ./node_modules/jest/bin/jest --config config-jest.js'
      },
      {
        name: 'cucumber',
        command: './node_modules/.bin/cucumber-js ci-visibility/features-selenium/*.feature'
      }
    ]
    testFrameworks.forEach(({ name, command }) => {
      context(`with ${name}`, () => {
        it('identifies tests using selenium as browser tests', (done) => {
          const assertionPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const seleniumTest = events.find(event => event.type === 'test').content
              assert.include(seleniumTest.meta, {
                [TEST_BROWSER_DRIVER]: 'selenium',
                [TEST_BROWSER_NAME]: 'chrome',
                [TEST_TYPE]: 'browser',
                [TEST_IS_RUM_ACTIVE]: 'true'
              })
              assert.property(seleniumTest.meta, TEST_BROWSER_VERSION)
              assert.property(seleniumTest.meta, TEST_BROWSER_DRIVER_VERSION)
            })

          childProcess = exec(
            command,
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                WEB_APP_URL: `http://localhost:${webAppPort}`,
                TESTS_TO_RUN: '**/ci-visibility/test/selenium-test*'
              },
              stdio: 'inherit'
            }
          )

          childProcess.on('exit', () => {
            assertionPromise.then(() => {
              done()
            }).catch(done)
          })
        })
      })
    })

    it('does not crash when used outside a known test framework', (done) => {
      let testOutput = ''
      childProcess = exec(
        'node ./ci-visibility/test/selenium-no-framework.js',
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            WEB_APP_URL: `http://localhost:${webAppPort}`,
            TESTS_TO_RUN: '**/ci-visibility/test/selenium-test*'
          },
          stdio: 'pipe'
        }
      )

      childProcess.on('exit', (code) => {
        assert.equal(code, 0)
        assert.notInclude(testOutput, 'InvalidArgumentError')
        done()
      })

      childProcess.stdout.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
    })
  })
})
