'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const nock = require('nock')
const semver = require('semver')

const fs = require('node:fs')
const path = require('node:path')

const { COMPONENT } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const {
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS,
  TEST_COMMAND,
  TEST_TOOLCHAIN,
  TEST_SUITE_ID,
  TEST_SESSION_ID,
  TEST_MODULE_ID,
  TEST_MODULE
} = require('../../dd-trace/src/plugins/util/test')

/**
 * The assertion timeout needs to be less than the test timeout,
 * otherwise failing tests will always fail due to a timeout,
 * which is less useful than having an assertion error message.
 */
const assertionTimeout = 15000
const testTimeout = 20000

function loadAgent (moduleName, version, isAgentlessTest, isEvpProxyTest) {
  const exporter = isAgentlessTest ? 'datadog' : 'agent_proxy'
  if (!isEvpProxyTest) {
    agent.setAvailableEndpoints([])
  }
  return agent.load(
    ['jest', 'http'],
    { service: 'test' },
    { isCiVisibility: true, experimental: { exporter } })
    .then(() => {
      global.__libraryName__ = moduleName
      global.__libraryVersion__ = version

      return {
        jestExecutable: require(`../../../versions/jest@${version}`).get(),
        jestCommonOptions: {
          projects: [__dirname],
          testPathIgnorePatterns: ['/node_modules/'],
          coverageReporters: ['none'],
          reporters: [],
          silent: true,
          testEnvironment: path.join(__dirname, 'env.js'),
          testRunner: require(`../../../versions/jest-circus@${version}`).getPath('jest-circus/runner'),
          cache: false,
          maxWorkers: '50%'
        }
      }
    })
}

describe('Plugin', function () {
  let jestExecutable
  let jestCommonOptions

  this.timeout(testTimeout)
  this.retries(2)

  const versions = ['jest-environment-node', 'jest-environment-jsdom']

  withVersions('jest', versions, (version, moduleName) => {
    afterEach(() => {
      delete process.env.DD_API_KEY
      const jestTestFile = fs.readdirSync(__dirname).filter(name => name.startsWith('jest-'))
      jestTestFile.forEach((testFile) => {
        delete require.cache[require.resolve(path.join(__dirname, testFile))]
      })
      delete require.cache[require.resolve(path.join(__dirname, 'env.js'))]
      nock.cleanAll()
      return agent.close({ ritmReset: false, wipe: true })
    })
    beforeEach(function () {
      process.env.DD_API_KEY = 'key'
    })
    describe('jest with jest-circus', () => {
      describe('older versions of the agent', () => {
        beforeEach(async () => {
          nock('http://test:123')
            .get('/')
            .reply(200, 'OK')

          const loadedAgent = await loadAgent(moduleName, version, false, false)
          jestExecutable = loadedAgent.jestExecutable
          jestCommonOptions = loadedAgent.jestCommonOptions
        })

        // option available from 26.5.0:
        // https://github.com/facebook/jest/blob/7f2731ef8bebac7f226cfc0d2446854603a557a9/CHANGELOG.md#2650
        if (semver.intersects(version, '>=26.5.0')) {
          it('does not crash when injectGlobals is false', (done) => {
            agent.assertSomeTraces(trace => {
              const testSpan = trace[0].find(span => span.type === 'test')
              expect(testSpan.meta).to.contain({
                [TEST_NAME]: 'jest-inject-globals will be run',
                [TEST_STATUS]: 'pass',
                [TEST_SUITE]: 'packages/datadog-plugin-jest/test/jest-inject-globals.js'
              })
            }, { timeoutMs: assertionTimeout }).then(() => done()).catch(done)

            const options = {
              ...jestCommonOptions,
              testRegex: 'jest-inject-globals.js',
              injectGlobals: false
            }

            jestExecutable.runCLI(
              options,
              options.projects
            )
          })
        }
      })

      const initOptions = ['agentless', 'evp proxy']

      initOptions.forEach(option => {
        describe(`reporting through ${option}`, () => {
          beforeEach(async () => {
            const isAgentlessTest = option === 'agentless'
            const isEvpProxyTest = option === 'evp proxy'

            const loadedAgent = await loadAgent(moduleName, version, isAgentlessTest, isEvpProxyTest)
            jestExecutable = loadedAgent.jestExecutable
            jestCommonOptions = loadedAgent.jestCommonOptions
          })

          it('should create events for session, suite and test', (done) => {
            const events = [
              {
                type: 'test_session_end',
                status: 'pass',
                spanResourceMatch: /^test_session/
              },
              {
                type: 'test_suite_end',
                status: 'pass',
                suite: 'packages/datadog-plugin-jest/test/jest-test-suite.js',
                spanResourceMatch: /^test_suite/
              },
              {
                name: 'jest-test-suite-visibility works',
                suite: 'packages/datadog-plugin-jest/test/jest-test-suite.js',
                status: 'pass',
                type: 'test',
                spanResourceMatch: /jest-test-suite-visibility works$/
              }
            ]

            const assertionPromises = events.map(({ name, suite, status, type, spanResourceMatch }) => {
              return agent.assertSomeTraces((agentlessPayload, request) => {
                if (option === 'evp proxy') {
                  expect(request.headers['x-datadog-evp-subdomain']).to.equal('citestcycle-intake')
                  expect(request.path).to.equal('/evp_proxy/v2/api/v2/citestcycle')
                } else {
                  expect(request.path).to.equal('/api/v2/citestcycle')
                }
                const { events } = agentlessPayload
                const span = events.find(event => event.type === type).content
                expect(span.meta[TEST_STATUS]).to.equal(status)
                expect(span.meta[COMPONENT]).to.equal('jest')
                if (type === 'test_session_end') { // session and module come in the same payload
                  expect(span.meta[TEST_COMMAND]).not.to.equal(undefined)
                  expect(span.meta[TEST_TOOLCHAIN]).not.to.equal(undefined)
                  expect(span[TEST_SUITE_ID]).to.equal(undefined)
                  expect(span[TEST_MODULE_ID]).to.equal(undefined)
                  expect(span[TEST_SESSION_ID]).not.to.equal(undefined)
                  const testModuleSpan = events.find(event => event.type === 'test_module_end').content
                  expect(testModuleSpan[TEST_SUITE_ID]).to.equal(undefined)
                  expect(testModuleSpan[TEST_MODULE_ID]).not.to.equal(undefined)
                  expect(testModuleSpan[TEST_SESSION_ID]).not.to.equal(undefined)
                  expect(testModuleSpan.meta[TEST_MODULE]).not.to.equal(undefined)
                }
                if (type === 'test_suite_end') {
                  expect(span.meta[TEST_SUITE]).to.equal(suite)
                  expect(span.meta[TEST_COMMAND]).not.to.equal(undefined)
                  expect(span.meta[TEST_MODULE]).not.to.equal(undefined)
                  expect(span[TEST_SUITE_ID]).not.to.equal(undefined)
                  expect(span[TEST_SESSION_ID]).not.to.equal(undefined)
                  expect(span[TEST_MODULE_ID]).not.to.equal(undefined)
                }
                if (type === 'test') {
                  expect(span.meta[TEST_SUITE]).to.equal(suite)
                  expect(span.meta[TEST_NAME]).to.equal(name)
                  expect(span.meta[TEST_COMMAND]).not.to.equal(undefined)
                  expect(span.meta[TEST_MODULE]).not.to.equal(undefined)
                  expect(span[TEST_SUITE_ID]).not.to.equal(undefined)
                  expect(span[TEST_SESSION_ID]).not.to.equal(undefined)
                  expect(span[TEST_MODULE_ID]).not.to.equal(undefined)
                }
              }, { timeoutMs: assertionTimeout, spanResourceMatch })
            })

            Promise.all(assertionPromises).then(() => done()).catch(done)

            const options = {
              ...jestCommonOptions,
              testRegex: 'jest-test-suite.js'
            }

            jestExecutable.runCLI(
              options,
              options.projects
            )
          })
        })
      })
    })
  })
})
