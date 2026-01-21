'use strict'

const assert = require('node:assert/strict')

const { exec } = require('child_process')
const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  assertObjectContains
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
const { NODE_MAJOR } = require('../../version')

const webAppServer = require('../ci-visibility/web-app-server')

const versionRange = ['4.11.0', 'latest']

versionRange.forEach(version => {
  describe(`selenium ${version}`, () => {
    let receiver
    let childProcess
    let cwd
    let webAppPort

    useSandbox([
      'mocha',
      'jest',
      '@cucumber/cucumber',
      `selenium-webdriver@${version}`
    ])

    before(function (done) {
      cwd = sandboxCwd()

      webAppServer.listen(0, () => {
        const address = webAppServer.address()
        if (!address || typeof address === 'string') {
          return done(new Error('Failed to determine web app server port'))
        }
        webAppPort = address.port
        done()
      })
    })

    after(async function () {
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
      if ((NODE_MAJOR === 18 || NODE_MAJOR === 23) && name === 'cucumber') return

      context(`with ${name}`, () => {
        it('identifies tests using selenium as browser tests', (done) => {
          const assertionPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const seleniumTest = events.find(event => event.type === 'test').content

              assertObjectContains(seleniumTest, {
                meta: {
                  [TEST_BROWSER_DRIVER]: 'selenium',
                  [TEST_BROWSER_NAME]: 'chrome',
                  [TEST_TYPE]: 'browser',
                  [TEST_IS_RUM_ACTIVE]: 'true',
                }
              })

              assert.ok(Object.hasOwn(seleniumTest.meta, TEST_BROWSER_VERSION))
              assert.ok(Object.hasOwn(seleniumTest.meta, TEST_BROWSER_DRIVER_VERSION))
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
        }
      )

      childProcess.on('exit', (code) => {
        assert.strictEqual(code, 0)
        assert.doesNotMatch(testOutput, /InvalidArgumentError/)
        done()
      })

      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
    })
  })
})
