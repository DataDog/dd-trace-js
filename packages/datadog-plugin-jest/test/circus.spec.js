'use strict'
const fs = require('fs')
const path = require('path')

const { ORIGIN_KEY } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME: TEST_NAME_TAG,
  TEST_SUITE: TEST_SUITE_TAG,
  TEST_FRAMEWORK_VERSION,
  TEST_STATUS,
  CI_APP_ORIGIN,
  JEST_TEST_RUNNER
} = require('../../dd-trace/src/plugins/util/test')

describe('Plugin', function () {
  let jestExecutable
  let jestCommonOptions

  this.timeout(60000)

  withVersions('jest', ['jest-environment-node'], (version, moduleName) => {
    afterEach(() => {
      const jestTestFile = fs.readdirSync(__dirname).filter(name => name.startsWith('jest-'))
      jestTestFile.forEach((testFile) => {
        delete require.cache[require.resolve(path.join(__dirname, testFile))]
      })
      delete require.cache[require.resolve(path.join(__dirname, 'env.js'))]
      delete require.cache[require.resolve(path.join(__dirname, '../../../ci/jest/env'))]
      delete global._ddtrace
      // delete require.cache[require.resolve('jest-environment-node')]
      return agent.close({ ritmReset: false })
    })
    beforeEach(() => {
      // THERE'S A LEAK WITH THIS
      // process.env.DD_TRACE_DISABLED_PLUGINS = 'fs'

      return agent.load(['jest'], { service: 'test' }).then(() => {
        global.__libraryVersion__ = version
        jestExecutable = require(`../../../versions/jest@${version}`).get()

        jestCommonOptions = {
          projects: [__dirname],
          testPathIgnorePatterns: ['/node_modules/'],
          coverageReporters: [],
          reporters: [],
          silent: true,
          testEnvironment: path.join(__dirname, 'env.js'),
          testRunner: require(`../../../versions/jest-circus@${version}`).getPath('jest-circus/runner'),
          cache: false,
          maxWorkers: '50%'
        }
      })
    })
    describe('jest with jest-circus', () => {
      it('should create test spans for sync and async tests', (done) => {
        const tests = [
          { name: 'jest-circus-test-suite passes', status: 'pass' },
          { name: 'jest-circus-test-suite fails', status: 'fail' },
          { name: 'jest-circus-test-suite done', status: 'pass' },
          { name: 'jest-circus-test-suite done fail', status: 'fail' },
          { name: 'jest-circus-test-suite done fail uncaught', status: 'fail' },
          { name: 'jest-circus-test-suite promise passes', status: 'pass' },
          { name: 'jest-circus-test-suite promise fails', status: 'fail' },
          { name: 'jest-circus-test-suite timeout', status: 'fail' }
        ]

        const assertionPromises = tests.map(({ name, status }) => {
          return agent.use(trace => {
            const testSpan = trace[0][0]
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(testSpan.meta).to.contain({
              language: 'javascript',
              service: 'test',
              [ORIGIN_KEY]: CI_APP_ORIGIN,
              [TEST_FRAMEWORK]: 'jest',
              [TEST_NAME_TAG]: name,
              [TEST_STATUS]: status,
              [TEST_SUITE_TAG]: 'packages/datadog-plugin-jest/test/jest-circus-test.js',
              [TEST_TYPE]: 'test',
              [JEST_TEST_RUNNER]: 'jest-circus'
            })
            expect(testSpan.type).to.equal('test')
            expect(testSpan.name).to.equal('jest.test')
            expect(testSpan.service).to.equal('test')
            expect(testSpan.resource).to.equal(`packages/datadog-plugin-jest/test/jest-circus-test.js.${name}`)
            expect(testSpan.meta[TEST_FRAMEWORK_VERSION]).not.to.be.undefined
          })
        })

        Promise.all(assertionPromises).then(() => done()).catch(done)

        const options = {
          ...jestCommonOptions,
          testRegex: 'jest-circus-test.js'
        }

        jestExecutable.runCLI(
          options,
          options.projects
        )
      })
    })
  })
})
