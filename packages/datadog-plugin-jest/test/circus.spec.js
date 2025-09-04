'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const nock = require('nock')
const semver = require('semver')

const fs = require('node:fs')
const path = require('node:path')

const { ORIGIN_KEY, COMPONENT, ERROR_MESSAGE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_SOURCE_FILE,
  TEST_SOURCE_START,
  TEST_FRAMEWORK_VERSION,
  TEST_STATUS,
  CI_APP_ORIGIN,
  JEST_TEST_RUNNER,
  TEST_PARAMETERS,
  TEST_CODE_OWNERS,
  LIBRARY_VERSION,
  TEST_COMMAND,
  TEST_TOOLCHAIN,
  TEST_SUITE_ID,
  TEST_SESSION_ID,
  TEST_MODULE_ID,
  TEST_MODULE
} = require('../../dd-trace/src/plugins/util/test')

const { version: ddTraceVersion } = require('../../../package.json')

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
  return agent.load(['jest', 'http'], { service: 'test' }, { experimental: { exporter } }).then(() => {
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

  withVersions('jest', ['jest-environment-node', 'jest-environment-jsdom'], (version, moduleName) => {
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

        it('should create test spans for sync, async, integration, parameterized and retried tests', (done) => {
          const tests = [
            {
              name: 'jest-test-suite tracer and active span are available',
              status: 'pass',
              extraTags: { 'test.add.stuff': 'stuff' }
            },
            { name: 'jest-test-suite done', status: 'pass' },
            { name: 'jest-test-suite done fail', status: 'fail' },
            { name: 'jest-test-suite done fail uncaught', status: 'fail' },
            { name: 'jest-test-suite can do integration http', status: 'pass' },
            {
              name: 'jest-test-suite can do parameterized test',
              status: 'pass',
              parameters: { arguments: [1, 2, 3], metadata: {} }
            },
            {
              name: 'jest-test-suite can do parameterized test',
              status: 'pass',
              parameters: { arguments: [2, 3, 5], metadata: {} }
            },
            { name: 'jest-test-suite promise passes', status: 'pass' },
            { name: 'jest-test-suite promise fails', status: 'fail' },
            { name: 'jest-test-suite timeout', status: 'fail', error: 'Exceeded timeout' },
            { name: 'jest-test-suite passes', status: 'pass' },
            { name: 'jest-test-suite fails', status: 'fail' },
            { name: 'jest-test-suite does not crash with missing stack', status: 'fail' },
            { name: 'jest-test-suite skips', status: 'skip' },
            { name: 'jest-test-suite skips todo', status: 'skip' },
            { name: 'jest-circus-test-retry can retry', status: 'fail' },
            { name: 'jest-circus-test-retry can retry', status: 'fail' },
            { name: 'jest-circus-test-retry can retry', status: 'pass' }
          ]

          const assertionPromises = tests.map(({ name, status, error, parameters, extraTags }) => {
            return agent.assertSomeTraces(trace => {
              const testSpan = trace[0][0]
              expect(testSpan.parent_id.toString()).to.equal('0')
              expect(testSpan.meta).to.contain({
                language: 'javascript',
                service: 'test',
                [ORIGIN_KEY]: CI_APP_ORIGIN,
                [TEST_FRAMEWORK]: 'jest',
                [TEST_NAME]: name,
                [TEST_STATUS]: status,
                [TEST_SUITE]: 'packages/datadog-plugin-jest/test/jest-test.js',
                [TEST_SOURCE_FILE]: 'packages/datadog-plugin-jest/test/jest-test.js',
                [TEST_TYPE]: 'test',
                [JEST_TEST_RUNNER]: 'jest-circus',
                [LIBRARY_VERSION]: ddTraceVersion,
                [COMPONENT]: 'jest'
              })
              // reads from dd-trace-js' CODEOWNERS
              expect(testSpan.meta[TEST_CODE_OWNERS]).to.contain('@DataDog')

              if (extraTags) {
                expect(testSpan.meta).to.contain(extraTags)
              }
              if (error) {
                expect(testSpan.meta[ERROR_MESSAGE]).to.include(error)
              }
              if (name === 'jest-test-suite can do integration http') {
                const httpSpan = trace[0].find(span => span.name === 'http.request')
                expect(httpSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
                expect(httpSpan.meta['http.url']).to.equal('http://test:123/')
                expect(httpSpan.parent_id.toString()).to.equal(testSpan.span_id.toString())
              }
              if (parameters) {
                expect(testSpan.meta[TEST_PARAMETERS]).to.equal(JSON.stringify(parameters))
              }
              expect(testSpan.type).to.equal('test')
              expect(testSpan.name).to.equal('jest.test')
              expect(testSpan.service).to.equal('test')
              expect(testSpan.resource).to.equal(`packages/datadog-plugin-jest/test/jest-test.js.${name}`)
              expect(testSpan.metrics[TEST_SOURCE_START]).to.exist
              expect(testSpan.meta[TEST_FRAMEWORK_VERSION]).not.to.be.undefined
            }, {
              timeoutMs: assertionTimeout,
              spanResourceMatch: new RegExp(`${name}$`)
            })
          })

          Promise.all(assertionPromises).then(() => done()).catch(done)

          const options = {
            ...jestCommonOptions,
            testRegex: 'jest-test.js'
          }

          jestExecutable.runCLI(
            options,
            options.projects
          )
        })

        it('should detect an error in hooks', (done) => {
          const tests = [
            { name: 'jest-hook-failure will not run', error: 'hey, hook error before' },
            { name: 'jest-hook-failure-after will not run', error: 'hey, hook error after' }
          ]
          const assertionPromises = tests.map(({ name, error }) => {
            return agent.assertSomeTraces(trace => {
              const testSpan = trace[0][0]
              expect(testSpan.parent_id.toString()).to.equal('0')
              expect(testSpan.meta).to.contain({
                language: 'javascript',
                service: 'test',
                [ORIGIN_KEY]: CI_APP_ORIGIN,
                [TEST_FRAMEWORK]: 'jest',
                [TEST_NAME]: name,
                [TEST_STATUS]: 'fail',
                [TEST_SUITE]: 'packages/datadog-plugin-jest/test/jest-hook-failure.js',
                [TEST_SOURCE_FILE]: 'packages/datadog-plugin-jest/test/jest-hook-failure.js',
                [TEST_TYPE]: 'test',
                [JEST_TEST_RUNNER]: 'jest-circus',
                [COMPONENT]: 'jest'
              })
              expect(testSpan.meta[ERROR_MESSAGE]).to.equal(error)
              expect(testSpan.type).to.equal('test')
              expect(testSpan.name).to.equal('jest.test')
              expect(testSpan.service).to.equal('test')
              expect(testSpan.resource).to.equal(
                `packages/datadog-plugin-jest/test/jest-hook-failure.js.${name}`
              )
              expect(testSpan.meta[TEST_FRAMEWORK_VERSION]).not.to.be.undefined
            }, {
              timeoutMs: assertionTimeout,
              spanResourceMatch: new RegExp(`${name}$`)
            })
          })

          Promise.all(assertionPromises).then(() => done()).catch(done)

          const options = {
            ...jestCommonOptions,
            testRegex: 'jest-hook-failure.js'
          }

          jestExecutable.runCLI(
            options,
            options.projects
          )
        })

        it('should work with focused tests', (done) => {
          const tests = [
            { name: 'jest-test-focused will be skipped', status: 'skip' },
            { name: 'jest-test-focused-2 will be skipped too', status: 'skip' },
            { name: 'jest-test-focused can do focused test', status: 'pass' }
          ]

          const assertionPromises = tests.map(({ name, status }) => {
            return agent.assertSomeTraces(trace => {
              const testSpan = trace[0].find(span => span.type === 'test')
              expect(testSpan.parent_id.toString()).to.equal('0')
              expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
              expect(testSpan.meta).to.contain({
                language: 'javascript',
                service: 'test',
                [TEST_NAME]: name,
                [TEST_STATUS]: status,
                [TEST_FRAMEWORK]: 'jest',
                [TEST_SUITE]: 'packages/datadog-plugin-jest/test/jest-focus.js',
                [TEST_SOURCE_FILE]: 'packages/datadog-plugin-jest/test/jest-focus.js',
                [COMPONENT]: 'jest'
              })
            }, {
              timeoutMs: assertionTimeout,
              spanResourceMatch: new RegExp(`${name}$`)
            })
          })

          Promise.all(assertionPromises).then(() => done()).catch(done)

          const options = {
            ...jestCommonOptions,
            testRegex: 'jest-focus.js'
          }

          jestExecutable.runCLI(
            options,
            options.projects
          )
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
