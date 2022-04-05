'use strict'
const fs = require('fs')
const path = require('path')

const nock = require('nock')

const { ORIGIN_KEY } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_FRAMEWORK_VERSION,
  TEST_STATUS,
  CI_APP_ORIGIN,
  JEST_TEST_RUNNER,
  ERROR_MESSAGE
} = require('../../dd-trace/src/plugins/util/test')

describe.only('Plugin', function () {
  let jestExecutable
  let jestCommonOptions

  this.timeout(60000)

  withVersions('jest', ['jest-environment-node', 'jest-environment-jsdom'], (version, moduleName) => {
    afterEach(() => {
      const jestTestFile = fs.readdirSync(__dirname).filter(name => name.startsWith('jest-'))
      jestTestFile.forEach((testFile) => {
        delete require.cache[require.resolve(path.join(__dirname, testFile))]
      })
      delete require.cache[require.resolve(path.join(__dirname, 'env.js'))]
      delete global._ddtrace
      return agent.close({ ritmReset: false })
    })
    beforeEach(() => {
      // THERE'S A LEAK WITH THIS
      // process.env.DD_TRACE_DISABLED_PLUGINS = 'fs'

      // for http integration tests
      nock('http://test:123')
        .get('/')
        .reply(200, 'OK')

      return agent.load(['jest', 'http'], { service: 'test' }).then(() => {
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
          { name: 'jest-circus-test-suite timeout', status: 'fail', error: 'Exceeded timeout' },
          { name: 'jest-circus-test-suite skip', status: 'skip' }
        ]

        const assertionPromises = tests.map(({ name, status, error }) => {
          return agent.use(trace => {
            const testSpan = trace[0][0]
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(testSpan.meta).to.contain({
              language: 'javascript',
              service: 'test',
              [ORIGIN_KEY]: CI_APP_ORIGIN,
              [TEST_FRAMEWORK]: 'jest',
              [TEST_NAME]: name,
              [TEST_STATUS]: status,
              [TEST_SUITE]: 'packages/datadog-plugin-jest/test/jest-circus-test.js',
              [TEST_TYPE]: 'test',
              [JEST_TEST_RUNNER]: 'jest-circus'
            })
            if (error) {
              expect(testSpan.meta[ERROR_MESSAGE]).to.include(error)
            }
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
      it('should create test spans for retried tests', (done) => {
        const tests = [
          { status: 'fail' },
          { status: 'fail' },
          { status: 'pass' }
        ]
        const assertionPromises = tests.map(({ status }) => {
          return agent.use(trace => {
            const testSpan = trace[0][0]
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(testSpan.meta).to.contain({
              language: 'javascript',
              service: 'test',
              [ORIGIN_KEY]: CI_APP_ORIGIN,
              [TEST_FRAMEWORK]: 'jest',
              [TEST_NAME]: 'jest-circus-test-retry can retry',
              [TEST_STATUS]: status,
              [TEST_SUITE]: 'packages/datadog-plugin-jest/test/jest-circus-retry.js',
              [TEST_TYPE]: 'test',
              [JEST_TEST_RUNNER]: 'jest-circus'
            })
            expect(testSpan.type).to.equal('test')
            expect(testSpan.name).to.equal('jest.test')
            expect(testSpan.service).to.equal('test')
            expect(testSpan.resource).to.equal(
              'packages/datadog-plugin-jest/test/jest-circus-retry.js.jest-circus-test-retry can retry'
            )
            expect(testSpan.meta[TEST_FRAMEWORK_VERSION]).not.to.be.undefined
          })
        })

        Promise.all(assertionPromises).then(() => done()).catch(done)

        const options = {
          ...jestCommonOptions,
          testRegex: 'jest-circus-retry.js'
        }

        jestExecutable.runCLI(
          options,
          options.projects
        )
      })
      it('should detect an error in hooks', (done) => {
        const tests = [
          { name: 'jest-circus-hook-failure will not run' },
          { name: 'jest-circus-hook-failure-after will not run' }
        ]
        const assertionPromises = tests.map(({ name }) => {
          return agent.use(trace => {
            const testSpan = trace[0][0]
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(testSpan.meta).to.contain({
              language: 'javascript',
              service: 'test',
              [ORIGIN_KEY]: CI_APP_ORIGIN,
              [TEST_FRAMEWORK]: 'jest',
              [TEST_NAME]: name,
              [TEST_STATUS]: 'fail',
              [TEST_SUITE]: 'packages/datadog-plugin-jest/test/jest-circus-hook-failure.js',
              [TEST_TYPE]: 'test',
              [JEST_TEST_RUNNER]: 'jest-circus'
            })
            expect(testSpan.type).to.equal('test')
            expect(testSpan.name).to.equal('jest.test')
            expect(testSpan.service).to.equal('test')
            expect(testSpan.resource).to.equal(
              `packages/datadog-plugin-jest/test/jest-circus-hook-failure.js.${name}`
            )
            expect(testSpan.meta[TEST_FRAMEWORK_VERSION]).not.to.be.undefined
          })
        })

        Promise.all(assertionPromises).then(() => done()).catch(done)

        const options = {
          ...jestCommonOptions,
          testRegex: 'jest-circus-hook-failure.js'
        }

        jestExecutable.runCLI(
          options,
          options.projects
        )
      })
      // parameterized tests

      // integration
      it.only('should work with integrations', (done) => {
        agent.use(trace => {
          const httpSpan = trace[0].find(span => span.name === 'http.request')
          const testSpan = trace[0].find(span => span.type === 'test')
          expect(testSpan.parent_id.toString()).to.equal('0')
          expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
          expect(httpSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
          expect(httpSpan.meta['http.url']).to.equal('http://test:123/')
          expect(httpSpan.parent_id.toString()).to.equal(testSpan.span_id.toString())
          expect(testSpan.meta).to.contain({
            language: 'javascript',
            service: 'test',
            [TEST_NAME]: 'jest-test-integration-http can do integration http',
            [TEST_STATUS]: 'pass',
            [TEST_FRAMEWORK]: 'jest',
            [TEST_SUITE]: 'packages/datadog-plugin-jest/test/jest-circus-integration.js'
          })
        }).then(() => done()).catch(done)

        const options = {
          ...jestCommonOptions,
          testRegex: 'jest-circus-integration.js'
        }

        jestExecutable.runCLI(
          options,
          options.projects
        )
      })
    })
  })
})
