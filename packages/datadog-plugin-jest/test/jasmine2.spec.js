'use strict'
const fs = require('fs')
const path = require('path')

const { ORIGIN_KEY } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')
const {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME: TEST_NAME_TAG,
  TEST_SUITE: TEST_SUITE_TAG,
  TEST_STATUS,
  CI_APP_ORIGIN,
  TEST_FRAMEWORK_VERSION,
  JEST_TEST_RUNNER
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
    testEnvironment: 'node',
    cache: false,
    maxWorkers: '50%'
  }

  withVersions(plugin, ['jest-jasmine2'], (version, moduleName) => {
    afterEach(() => {
      const jestTestFile = fs.readdirSync(__dirname).filter(name => name.startsWith('jest-'))
      jestTestFile.forEach((testFile) => {
        delete require.cache[require.resolve(path.join(__dirname, testFile))]
      })
      return agent.close()
    })
    beforeEach(() => {
      return agent.load(['jest'], { service: 'test' }).then(() => {
        jestExecutable = require(`../../../versions/jest@${version}`).get()
      })
    })
    describe('jest with jasmine', function () {
      this.timeout(60000)
      it('instruments async and sync tests', function (done) {
        const tests = [
          { name: 'jest-test-suite done', status: 'pass' },
          { name: 'jest-test-suite done fail', status: 'fail' },
          { name: 'jest-test-suite done fail uncaught', status: 'fail' },
          { name: 'jest-test-suite promise passes', status: 'pass' },
          { name: 'jest-test-suite promise fails', status: 'fail' },
          { name: 'jest-test-suite timeout', status: 'fail' },
          { name: 'jest-test-suite passes', status: 'pass' },
          { name: 'jest-test-suite fails', status: 'fail' },
          { name: 'jest-test-suite skips', status: 'skip' },
          { name: 'jest-test-suite skips with test too', status: 'skip' },
          { name: 'jest-test-suite does not crash with missing stack', status: 'fail' }
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
              [TEST_SUITE_TAG]: 'packages/datadog-plugin-jest/test/jest-test.js',
              [TEST_TYPE]: 'test',
              [JEST_TEST_RUNNER]: 'jest-jasmine2'
            })
            expect(testSpan.type).to.equal('test')
            expect(testSpan.name).to.equal('jest.test')
            expect(testSpan.service).to.equal('test')
            expect(testSpan.resource).to.equal(`packages/datadog-plugin-jest/test/jest-test.js.${name}`)
            expect(testSpan.meta[TEST_FRAMEWORK_VERSION]).not.to.be.undefined
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

      it('instruments test suites with focused tests', function (done) {
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

      it('works with jsdom too', function (done) {
        agent.use(trace => {
          const testSpan = trace[0][0]
          expect(testSpan.parent_id.toString()).to.equal('0')
          expect(testSpan.meta[TEST_STATUS]).to.equal('pass')
          expect(testSpan.meta[TEST_NAME_TAG]).to.equal('jest-jsdom-test will run with jsdom')
          expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
        }).then(done).catch(done)

        const options = {
          ...jestCommonOptions,
          testRegex: 'jest-jsdom-test.js',
          testEnvironment: 'jsdom'
        }

        jestExecutable.runCLI(
          options,
          options.projects
        )
      })
    })
  })
})
