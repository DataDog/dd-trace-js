'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const nock = require('nock')
const semver = require('semver')

const fs = require('node:fs')
const path = require('node:path')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const {
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS
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
    })
  })
})
