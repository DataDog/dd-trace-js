'use strict'
const { ORIGIN_KEY } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')
const {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME: TEST_NAME_TAG,
  TEST_SUITE: TEST_SUITE_TAG,
  TEST_STATUS,
  ERROR_TYPE,
  CI_APP_ORIGIN
} = require('../../dd-trace/src/plugins/util/test')

describe('Plugin', () => {
  let jestExecutable

  const jestCommonOptions = {
    projects: [__dirname],
    testPathIgnorePatterns: ['/node_modules/'],
    coverageReporters: [],
    reporters: [],
    testRunner: 'jest-jasmine2',
    silent: true,
    testEnvironment: 'node'
  }

  withVersions(plugin, ['jest-jasmine2'], (version, moduleName) => {
    afterEach(() => {
      return agent.close()
    })
    beforeEach(() => {
      return agent.load(['jest']).then(() => {
        jestExecutable = require(`../../../versions/jest@${version}`).get()
      })
    })
    describe('jest with jasmine', function () {
      this.timeout(5000)
      process.removeAllListeners('uncaughtException')
      it('instruments passing tests', function (done) {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()
        agent
          .use(traces => {
            const testSpan = traces[0][0]
            const testName = 'jest-test-suite passes'
            const testSuite = 'packages/datadog-plugin-jest/test/jest-pass-test.js'
            expect(testSpan.meta).to.contain({
              language: 'javascript',
              service: 'test',
              [ORIGIN_KEY]: CI_APP_ORIGIN,
              [TEST_FRAMEWORK]: 'jest',
              [TEST_NAME_TAG]: testName,
              [TEST_STATUS]: 'pass',
              [TEST_SUITE_TAG]: testSuite,
              [TEST_TYPE]: 'test'
            })
            expect(testSpan.type).to.equal('test')
            expect(testSpan.name).to.equal('jest.test')
            expect(testSpan.resource).to.equal(`${testSuite}.${testName}`)
          }).then(done).catch(done)

        const options = {
          ...jestCommonOptions,
          testRegex: 'jest-pass-test.js'
        }

        jestExecutable.runCLI(
          options,
          options.projects
        )
      })
      it('instruments failing tests', function (done) {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()
        agent
          .use(traces => {
            const testSpan = traces[0][0]
            const testName = 'jest-test-suite fails'
            const testSuite = 'packages/datadog-plugin-jest/test/jest-fail-test.js'
            expect(testSpan.meta).to.contain({
              language: 'javascript',
              service: 'test',
              [ORIGIN_KEY]: CI_APP_ORIGIN,
              [TEST_FRAMEWORK]: 'jest',
              [TEST_NAME_TAG]: testName,
              [TEST_STATUS]: 'fail',
              [TEST_SUITE_TAG]: testSuite,
              [TEST_TYPE]: 'test'
            })
            expect(testSpan.error).to.equal(1)
            expect(testSpan.type).to.equal('test')
            expect(testSpan.meta[ERROR_TYPE]).to.equal('Error')
            expect(testSpan.name).to.equal('jest.test')
            expect(testSpan.resource).to.equal(`${testSuite}.${testName}`)
          }).then(done).catch(done)

        const options = {
          ...jestCommonOptions,
          testRegex: 'jest-fail-test.js'
        }

        jestExecutable.runCLI(
          options,
          options.projects
        )
      })
      it('instruments async tests with done', function (done) {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

        const tests = [
          { name: 'jest-test-suite async done', status: 'pass' },
          { name: 'jest-test-suite async done fail', status: 'fail' },
          { name: 'jest-test-suite async done fail uncaught', status: 'fail' }
        ]
        const assertionPromises = tests.map(({ name, status }) => {
          return agent.use(trace => {
            const testSpan = trace[0][0]
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(testSpan.meta[TEST_STATUS]).to.equal(status)
            expect(testSpan.meta[TEST_NAME_TAG]).to.equal(name)
            expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
          })
        })

        Promise.all(assertionPromises).then(() => done()).catch(done)

        const options = {
          ...jestCommonOptions,
          testRegex: 'jest-async-done-test.js'
        }

        jestExecutable.runCLI(
          options,
          options.projects
        )
      })
      it('instruments async tests with promises', function (done) {
        this.timeout(10000)
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

        const tests = [
          { name: 'jest-test-suite promises passes', status: 'pass' },
          { name: 'jest-test-suite promises fails', status: 'fail' },
          { name: 'jest-test-suite promises timeout', status: 'fail' }
        ]
        const assertionPromises = tests.map(({ name, status }) => {
          return agent.use(trace => {
            const testSpan = trace[0][0]
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(testSpan.meta[TEST_STATUS]).to.equal(status)
            expect(testSpan.meta[TEST_NAME_TAG]).to.equal(name)
            expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
          })
        })

        Promise.all(assertionPromises).then(() => done()).catch(done)

        const options = {
          ...jestCommonOptions,
          testRegex: 'jest-async-promises-test.js'
        }

        jestExecutable.runCLI(
          options,
          options.projects
        )
      })
      it('instruments test suites with skipped tests', function (done) {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

        const tests = [
          { name: 'jest-skip-test will skip', status: 'skip' },
          { name: 'jest-skip-test will skip with test too', status: 'skip' },
          { name: 'jest-skip-test will run', status: 'pass' }
        ]
        const assertionPromises = tests.map(({ name, status }) => {
          return agent.use(trace => {
            const testSpan = trace[0][0]
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(testSpan.meta[TEST_STATUS]).to.equal(status)
            expect(testSpan.meta[TEST_NAME_TAG]).to.equal(name)
            expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
          })
        })

        Promise.all(assertionPromises).then(() => done()).catch(done)

        const options = {
          ...jestCommonOptions,
          testRegex: 'jest-skip-test.js'
        }

        jestExecutable.runCLI(
          options,
          options.projects
        )
      })
      it('instruments test suites with focused tests', function (done) {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

        agent.use(trace => {
          const testSpan = trace[0][0]
          expect(testSpan.parent_id.toString()).to.equal('0')
          expect(testSpan.meta[TEST_STATUS]).to.equal('pass')
          expect(testSpan.meta[TEST_NAME_TAG]).to.equal('jest-only-test will run')
          expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
        }).then(done).catch(done)

        const options = {
          ...jestCommonOptions,
          testRegex: 'jest-only-test.js'
        }

        jestExecutable.runCLI(
          options,
          options.projects
        )
      })
    })
  })
})
