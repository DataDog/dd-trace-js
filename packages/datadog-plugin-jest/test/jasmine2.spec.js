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
  TEST_SOURCE_FILE,
  TEST_STATUS,
  CI_APP_ORIGIN,
  TEST_FRAMEWORK_VERSION,
  JEST_TEST_RUNNER,
  ERROR_MESSAGE,
  TEST_CODE_OWNERS,
  LIBRARY_VERSION
} = require('../../dd-trace/src/plugins/util/test')

const { version: ddTraceVersion } = require('../../../package.json')

describe('Plugin', () => {
  let jestExecutable

  const jestCommonOptions = {
    projects: [__dirname],
    testPathIgnorePatterns: ['/node_modules/'],
    coverageReporters: [],
    reporters: [],
    silent: true,
    cache: false,
    maxWorkers: '50%'
  }

  withVersions('jest', ['jest-jasmine2'], (version) => {
    afterEach(() => {
      const jestTestFile = fs.readdirSync(__dirname).filter(name => name.startsWith('jest-'))
      jestTestFile.forEach((testFile) => {
        delete require.cache[require.resolve(path.join(__dirname, testFile))]
      })
      return agent.close({ ritmReset: false, wipe: true })
    })
    beforeEach(() => {
      // for http integration tests
      nock('http://test:123')
        .get('/')
        .reply(200, 'OK')

      return agent.load(['jest', 'http'], { service: 'test' }).then(() => {
        jestCommonOptions.testRunner =
          require(`../../../versions/jest@${version}`).getPath('jest-jasmine2')

        jestExecutable = require(`../../../versions/jest@${version}`).get()
      })
    })
    describe('jest with jasmine', function () {
      this.timeout(60000)
      it('instruments async, sync and integration tests', function (done) {
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
          { name: 'jest-test-suite promise passes', status: 'pass' },
          { name: 'jest-test-suite promise fails', status: 'fail' },
          { name: 'jest-test-suite timeout', status: 'fail' },
          { name: 'jest-test-suite passes', status: 'pass' },
          { name: 'jest-test-suite fails', status: 'fail' },
          { name: 'jest-test-suite does not crash with missing stack', status: 'fail' },
          { name: 'jest-test-suite skips', status: 'skip' },
          { name: 'jest-test-suite skips todo', status: 'skip' }
        ]
        const assertionPromises = tests.map(({ name, status, error, extraTags }) => {
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
              [TEST_SUITE]: 'packages/datadog-plugin-jest/test/jest-test.js',
              [TEST_SOURCE_FILE]: 'packages/datadog-plugin-jest/test/jest-test.js',
              [TEST_TYPE]: 'test',
              [JEST_TEST_RUNNER]: 'jest-jasmine2',
              [TEST_CODE_OWNERS]: JSON.stringify(['@DataDog/dd-trace-js']), // reads from dd-trace-js
              [LIBRARY_VERSION]: ddTraceVersion
            })
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
            expect(testSpan.type).to.equal('test')
            expect(testSpan.name).to.equal('jest.test')
            expect(testSpan.service).to.equal('test')
            expect(testSpan.resource).to.equal(`packages/datadog-plugin-jest/test/jest-test.js.${name}`)
            expect(testSpan.meta[TEST_FRAMEWORK_VERSION]).not.to.be.undefined
          }, { timeoutMs: 30000 })
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

      it('works when there is a hook error', (done) => {
        const tests = [
          { name: 'jest-hook-failure will not run', error: 'hey, hook error before' },
          { name: 'jest-hook-failure-after will not run', error: 'hey, hook error after' }
        ]

        const assertionPromises = tests.map(({ name, error }) => {
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
              [TEST_SUITE]: 'packages/datadog-plugin-jest/test/jest-hook-failure.js',
              [TEST_SOURCE_FILE]: 'packages/datadog-plugin-jest/test/jest-hook-failure.js',
              [TEST_TYPE]: 'test',
              [JEST_TEST_RUNNER]: 'jest-jasmine2'
            })
            expect(testSpan.meta[ERROR_MESSAGE]).to.equal(error)
            expect(testSpan.type).to.equal('test')
            expect(testSpan.name).to.equal('jest.test')
            expect(testSpan.service).to.equal('test')
            expect(testSpan.resource).to.equal(
              `packages/datadog-plugin-jest/test/jest-hook-failure.js.${name}`
            )
            expect(testSpan.meta[TEST_FRAMEWORK_VERSION]).not.to.be.undefined
          }, { timeoutMs: 30000 })
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
          return agent.use(trace => {
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
              [TEST_SOURCE_FILE]: 'packages/datadog-plugin-jest/test/jest-focus.js'
            })
          }, { timeoutMs: 30000 })
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
    })
  })
})
