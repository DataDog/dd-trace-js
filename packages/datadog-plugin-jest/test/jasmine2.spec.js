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
  CI_APP_ORIGIN
} = require('../../dd-trace/src/plugins/util/test')

describe('Plugin', () => {
  let jestExecutable
  withVersions(plugin, ['jest-jasmine2'], (version, moduleName) => {
    afterEach(() => {
      return agent.close()
    })
    beforeEach(() => {
      return agent.load(['jest']).then(() => {
        jestExecutable = require(`../../../versions/jest@${version}`).get()
      })
    })
    const envOptions = ['node', 'jsdom']
    envOptions.forEach(testEnvironment => {
      describe(`jest with jasmine and testEnvironment ${testEnvironment}`, function () {
        this.timeout(60000)
        const jestCommonOptions = {
          projects: [__dirname],
          testPathIgnorePatterns: ['/node_modules/'],
          coverageReporters: [],
          reporters: [],
          testRunner: 'jest-jasmine2',
          silent: true,
          testEnvironment
        }

        this.timeout(60000)
        it('instruments sync tests', function (done) {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

          const tests = [
            { name: 'jest-test-suite passes', status: 'pass' },
            { name: 'jest-test-suite fails', status: 'fail' },
            { name: 'jest-test-suite skips', status: 'skip' },
            { name: 'jest-test-suite skips with test too', status: 'skip' }
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
                [TEST_SUITE_TAG]: 'packages/datadog-plugin-jest/test/jest-sync-test.js',
                [TEST_TYPE]: 'test'
              })
              expect(testSpan.type).to.equal('test')
              expect(testSpan.name).to.equal('jest.test')
              expect(testSpan.resource).to.equal(`packages/datadog-plugin-jest/test/jest-sync-test.js.${name}`)
            })
          })

          Promise.all(assertionPromises).then(() => done()).catch(done)

          const options = {
            ...jestCommonOptions,
            testRegex: 'jest-sync-test.js'
          }

          jestExecutable.runCLI(
            options,
            options.projects
          )
        })
        it('instruments async tests', function (done) {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

          const tests = [
            { name: 'jest-test-suite async done', status: 'pass' },
            { name: 'jest-test-suite async done fail', status: 'fail' },
            { name: 'jest-test-suite async done fail uncaught', status: 'fail' },
            { name: 'jest-test-suite async promise passes', status: 'pass' },
            { name: 'jest-test-suite async promise fails', status: 'fail' },
            { name: 'jest-test-suite async timeout', status: 'fail' }
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
            testRegex: 'jest-async-test.js'
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
})
