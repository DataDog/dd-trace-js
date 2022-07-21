'use strict'

const path = require('path')
const fs = require('fs')

const nock = require('nock')

const agent = require('../../dd-trace/test/plugins/agent')
const { ORIGIN_KEY } = require('../../dd-trace/src/constants')
const {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_SOURCE_FILE,
  TEST_STATUS,
  TEST_PARAMETERS,
  ERROR_TYPE,
  ERROR_MESSAGE,
  ERROR_STACK,
  CI_APP_ORIGIN,
  TEST_FRAMEWORK_VERSION,
  TEST_CODE_OWNERS,
  LIBRARY_VERSION
} = require('../../dd-trace/src/plugins/util/test')

const { version: ddTraceVersion } = require('../../../package.json')

const ASYNC_TESTS = [
  {
    fileName: 'mocha-test-done-pass.js',
    testName: 'can do passed tests with done',
    root: 'mocha-test-done-pass',
    status: 'pass'
  },
  {
    fileName: 'mocha-test-done-fail.js',
    testName: 'can do failed tests with done',
    root: 'mocha-test-done-fail',
    status: 'fail'
  },
  {
    fileName: 'mocha-test-promise-pass.js',
    testName: 'can do passed promise tests',
    root: 'mocha-test-promise-pass',
    status: 'pass'
  },
  {
    fileName: 'mocha-test-promise-fail.js',
    testName: 'can do failed promise tests',
    root: 'mocha-test-promise-fail',
    status: 'fail'
  },
  {
    fileName: 'mocha-test-async-pass.js',
    testName: 'can do passed async tests',
    root: 'mocha-test-async-pass',
    status: 'pass'
  },
  {
    fileName: 'mocha-test-async-fail.js',
    testName: 'can do failed async tests',
    root: 'mocha-test-async-fail',
    status: 'fail'
  },
  {
    fileName: 'mocha-test-timeout-fail.js',
    testName: 'times out',
    root: 'mocha-test-timeout-fail',
    status: 'fail'
  },
  {
    fileName: 'mocha-test-timeout-pass.js',
    testName: 'does not timeout',
    root: 'mocha-test-timeout-pass',
    status: 'pass'
  }
]

describe('Plugin', () => {
  let Mocha
  withVersions('mocha', 'mocha', version => {
    afterEach(() => {
      // This needs to be done when using the programmatic API:
      // https://github.com/mochajs/mocha/wiki/Using-Mocha-programmatically
      // > If you want to run tests multiple times, you may need to clear Node's require cache
      // before subsequent calls in whichever manner best suits your needs.
      const mochaTestFiles = fs.readdirSync(__dirname).filter(name => name.startsWith('mocha-'))
      mochaTestFiles.forEach((testFile) => {
        delete require.cache[require.resolve(path.join(__dirname, testFile))]
      })
      return agent.close({ ritmReset: false })
    })
    beforeEach(() => {
      // for http integration tests
      nock('http://test:123')
        .get('/')
        .reply(200, 'OK')

      return agent.load(['mocha', 'http'], { isAgentlessEnabled: true }).then(() => {
        Mocha = require(`../../../versions/mocha@${version}`).get()
      })
    })
    describe('mocha', () => {
      it('works with passing tests', (done) => {
        const testFilePath = path.join(__dirname, 'mocha-test-pass.js')
        const testNames = [
          'mocha-test-pass can pass',
          'mocha-test-pass can pass two',
          'mocha-test-pass-two can pass',
          'mocha-test-pass-two can pass two'
        ]
        const assertionPromises = testNames.map(testName => {
          return agent.use(trace => {
            const testSpan = trace[0][0]
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(testSpan.meta[TEST_STATUS]).to.equal('pass')
            expect(testSpan.meta[TEST_NAME]).to.equal(testName)
            expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
            expect(testSpan.meta[TEST_FRAMEWORK_VERSION]).not.to.be.undefined
            expect(testSpan.meta[TEST_CODE_OWNERS]).to.equal(
              JSON.stringify(['@DataDog/apm-js']) // reads from dd-trace-js
            )
            expect(testSpan.meta[LIBRARY_VERSION]).to.equal(ddTraceVersion)
          })
        })
        Promise.all(assertionPromises)
          .then(() => done())
          .catch(done)

        const mocha = new Mocha({
          reporter: function () {} // silent on internal tests
        })
        mocha.addFile(testFilePath)
        mocha.run()
      })
      it('works with failing tests', (done) => {
        const testFilePath = path.join(__dirname, 'mocha-test-fail.js')
        const testSuite = testFilePath.replace(`${process.cwd()}/`, '')
        agent
          .use(traces => {
            const testSpan = traces[0][0]
            expect(testSpan.meta).to.contain({
              language: 'javascript',
              service: 'test',
              [TEST_NAME]: 'mocha-test-fail can fail',
              [TEST_STATUS]: 'fail',
              [TEST_TYPE]: 'test',
              [TEST_FRAMEWORK]: 'mocha',
              [TEST_SUITE]: testSuite,
              [TEST_SOURCE_FILE]: testSuite
            })
            expect(testSpan.meta).to.contain({
              [ERROR_TYPE]: 'AssertionError',
              [ERROR_MESSAGE]: 'expected true to equal false'
            })
            expect(testSpan.meta[ERROR_STACK]).not.to.be.undefined
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(testSpan.meta[TEST_SUITE].endsWith('mocha-test-fail.js')).to.equal(true)
            expect(testSpan.type).to.equal('test')
            expect(testSpan.name).to.equal('mocha.test')
            expect(testSpan.resource).to.equal(`${testSuite}.mocha-test-fail can fail`)
          }).then(done, done)

        const mocha = new Mocha({
          reporter: function () {} // silent on internal tests
        })
        mocha.addFile(testFilePath)
        mocha.run()
      })
      it('works with skipping tests', (done) => {
        const testFilePath = path.join(__dirname, 'mocha-test-skip.js')
        const testNames = [
          'mocha-test-skip can skip',
          'mocha-test-skip-different can skip too',
          'mocha-test-skip-different can skip twice',
          'mocha-test-programmatic-skip can skip too'
        ]
        const assertionPromises = testNames.map(testName => {
          return agent.use(trace => {
            const testSpan = trace[0][0]
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(testSpan.meta[TEST_STATUS]).to.equal('skip')
            expect(testSpan.meta[TEST_NAME]).to.equal(testName)
            expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
          })
        })
        Promise.all(assertionPromises)
          .then(() => done())
          .catch(done)

        const mocha = new Mocha({
          reporter: function () {} // silent on internal tests
        })
        mocha.addFile(testFilePath)
        mocha.run()
      })

      ASYNC_TESTS.forEach(test => {
        it(`works with async tests for ${test.fileName}`, (done) => {
          const testFilePath = path.join(__dirname, test.fileName)
          const testSuite = testFilePath.replace(`${process.cwd()}/`, '')
          agent
            .use(traces => {
              const testSpan = traces[0][0]
              expect(testSpan.meta).to.contain({
                language: 'javascript',
                service: 'test',
                [TEST_NAME]: `${test.root} ${test.testName}`,
                [TEST_STATUS]: test.status,
                [TEST_TYPE]: 'test',
                [TEST_FRAMEWORK]: 'mocha',
                [TEST_SUITE]: testSuite,
                [TEST_SOURCE_FILE]: testSuite
              })
              if (test.fileName === 'mocha-test-fail.js') {
                expect(testSpan.meta).to.contain({
                  [ERROR_TYPE]: 'AssertionError',
                  [ERROR_MESSAGE]: 'expected true to equal false'
                })
                expect(testSpan.meta[ERROR_STACK]).not.to.be.undefined
              }
              expect(testSpan.parent_id.toString()).to.equal('0')
              expect(testSpan.meta[TEST_SUITE].endsWith(test.fileName)).to.equal(true)
              expect(testSpan.type).to.equal('test')
              expect(testSpan.name).to.equal('mocha.test')
              expect(testSpan.resource).to.equal(`${testSuite}.${test.root} ${test.testName}`)
            }).then(done, done)

          const mocha = new Mocha({
            reporter: function () {} // silent on internal tests
          })
          mocha.addFile(testFilePath)
          mocha.run()
        })
      })

      it('works for parameterized tests', (done) => {
        const testFilePath = path.join(__dirname, 'mocha-test-parameterized.js')
        const testSuite = testFilePath.replace(`${process.cwd()}/`, '')
        agent
          .use(traces => {
            const testSpan = traces[0][0]
            expect(testSpan.meta).to.contain({
              language: 'javascript',
              service: 'test',
              [TEST_NAME]: 'mocha-parameterized can do parameterized',
              [TEST_STATUS]: 'pass',
              [TEST_TYPE]: 'test',
              [TEST_FRAMEWORK]: 'mocha',
              [TEST_SUITE]: testSuite,
              [TEST_SOURCE_FILE]: testSuite,
              [TEST_PARAMETERS]: JSON.stringify({ arguments: [1, 2, 3], metadata: {} })
            })
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(testSpan.meta[TEST_SUITE].endsWith('mocha-test-parameterized.js')).to.equal(true)
            expect(testSpan.type).to.equal('test')
            expect(testSpan.name).to.equal('mocha.test')
            expect(testSpan.resource).to.equal(`${testSuite}.mocha-parameterized can do parameterized`)
          }).then(done, done)

        const mocha = new Mocha({
          reporter: function () {} // silent on internal tests
        })
        mocha.addFile(testFilePath)
        mocha.run()
      })

      it('works with integrations', (done) => {
        const testFilePath = path.join(__dirname, 'mocha-test-integration.js')
        const testSuite = testFilePath.replace(`${process.cwd()}/`, '')

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
            [TEST_NAME]: 'mocha-test-integration-http can do integration http',
            [TEST_STATUS]: 'pass',
            [TEST_FRAMEWORK]: 'mocha',
            [TEST_SUITE]: testSuite,
            [TEST_SOURCE_FILE]: testSuite
          })
        }).then(done, done)

        const mocha = new Mocha({
          reporter: function () {} // silent on internal tests
        })
        mocha.addFile(testFilePath)
        mocha.run()
      })

      it('works with sync errors in the hooks', (done) => {
        const testFilePath = path.join(__dirname, 'mocha-fail-hook-sync.js')

        agent.use(traces => {
          const testSpan = traces[0][0]
          expect(testSpan.meta).to.contain({
            [ERROR_TYPE]: 'TypeError'
          })
          expect(testSpan.meta[ERROR_TYPE]).to.equal('TypeError')
          const beginning = `"before each" hook for "will not run but be reported as failed": `
          expect(testSpan.meta[ERROR_MESSAGE].startsWith(beginning)).to.equal(true)
          const errorMsg = testSpan.meta[ERROR_MESSAGE].replace(beginning, '')
          expect(
            errorMsg === `Cannot set property 'error' of undefined` ||
            errorMsg === `Cannot set properties of undefined (setting 'error')`
          ).to.equal(true)
          expect(testSpan.meta[ERROR_STACK]).not.to.be.undefined
        }).then(done, done)

        const mocha = new Mocha({
          reporter: function () {} // silent on internal tests
        })
        mocha.addFile(testFilePath)
        mocha.run()
      })

      it('active span is correct', (done) => {
        const testFilePath = path.join(__dirname, 'mocha-active-span-in-hooks.js')

        const testNames = [
          { name: 'mocha-active-span-in-hooks first test', status: 'pass' },
          { name: 'mocha-active-span-in-hooks second test', status: 'pass' }
        ]

        const assertionPromises = testNames.map(({ name, status }) => {
          return agent.use(trace => {
            const testSpan = trace[0][0]
            expect(testSpan.meta[TEST_NAME]).to.equal(name)
            expect(testSpan.meta[TEST_STATUS]).to.equal(status)
          })
        })

        Promise.all(assertionPromises)
          .then(() => done())
          .catch(done)

        const mocha = new Mocha({
          reporter: function () {} // silent on internal tests
        })
        mocha.addFile(testFilePath)
        mocha.run()
      })

      it('works with async errors in the hooks', (done) => {
        const testFilePath = path.join(__dirname, 'mocha-fail-hook-async.js')

        const testNames = [
          {
            name: 'mocha-fail-hook-async will run but be reported as failed',
            status: 'fail',
            errorMsg: '"after each" hook for "will run but be reported as failed": yeah error'
          },
          {
            name: 'mocha-fail-hook-async-other will run and be reported as passed',
            status: 'pass'
          },
          {
            name: 'mocha-fail-hook-async-other-before will not run and be reported as failed',
            status: 'fail',
            errorMsg: '"before each" hook for "will not run and be reported as failed": yeah error'
          },
          {
            name: 'mocha-fail-hook-async-other-second-after will run and be reported as failed',
            status: 'fail',
            errorMsg: '"after each" hook for "will run and be reported as failed": yeah error'
          }
        ]

        const assertionPromises = testNames.map(({ name, status, errorMsg }) => {
          return agent.use(trace => {
            const testSpan = trace[0][0]
            expect(testSpan.meta[TEST_NAME]).to.equal(name)
            expect(testSpan.meta[TEST_STATUS]).to.equal(status)
            if (errorMsg) {
              expect(testSpan.meta[ERROR_MESSAGE].startsWith(errorMsg)).to.equal(true)
              expect(testSpan.meta[ERROR_TYPE]).to.equal('Error')
              expect(testSpan.meta[ERROR_STACK]).not.to.be.undefined
            }
          })
        })

        Promise.all(assertionPromises)
          .then(() => done())
          .catch(done)

        const mocha = new Mocha({
          reporter: function () {} // silent on internal tests
        })
        mocha.addFile(testFilePath)
        mocha.run()
      })

      it('works with async tests with done fail', (done) => {
        // necessary because we run mocha within mocha and mocha adds a handler for uncaughtExceptions.
        // If we don't do this, the handler for the parent test (this test) will be called
        // first and not the one for mocha-test-done-fail-badly.js (test we are testing).
        process.removeAllListeners('uncaughtException')
        const testFilePath = path.join(__dirname, 'mocha-test-done-fail-badly.js')
        agent.use(traces => {
          const testSpan = traces[0][0]
          expect(testSpan.meta[ERROR_TYPE]).to.equal('AssertionError')
          expect(testSpan.meta[ERROR_MESSAGE]).to.equal('expected true to equal false')
          expect(testSpan.meta[ERROR_STACK].startsWith('AssertionError: expected true to equal false')).to.equal(true)
          expect(testSpan.meta[TEST_STATUS]).to.equal('fail')
          expect(testSpan.meta[TEST_NAME]).to.equal('mocha-test-done-fail can do badly setup failed tests with done')
        }).then(done, done)
        const mocha = new Mocha({
          reporter: function () {} // silent on internal tests
        })
        mocha.addFile(testFilePath)
        mocha.run()
      })

      it('works with retries', (done) => {
        const testFilePath = path.join(__dirname, 'mocha-test-retries.js')

        const testNames = [
          ['mocha-test-retries will be retried and pass', 'pass'],
          ['mocha-test-retries will be retried and fail', 'fail']
        ]

        const assertionPromises = testNames.map(([testName, status]) => {
          return agent.use(trace => {
            const testSpan = trace[0][0]
            expect(testSpan.meta[TEST_STATUS]).to.equal(status)
            expect(testSpan.meta[TEST_NAME]).to.equal(testName)
          })
        })

        Promise.all(assertionPromises)
          .then(() => done())
          .catch(done)

        const mocha = new Mocha({
          reporter: function () {} // silent on internal tests
        })
        mocha.addFile(testFilePath)
        mocha.run()
      })

      it('works with test suite level visibility', (done) => {
        const testFilePath = path.join(__dirname, 'mocha-test-suite-level')
        const testFilePathSecond = path.join(__dirname, 'mocha-test-suite-level-2')

        agent.use(trace => {
          const spans = trace[0]
          const testSessionSpan = spans.find(span => span.type === 'test_session_end')
          const testSuiteSpans = spans.filter(span => span.type === 'test_suite_end')

          expect(testSessionSpan.meta[TEST_STATUS]).to.equal('fail')
          expect(testSuiteSpans.length).to.equal(4)

          expect(
            testSuiteSpans.every(span => span.parent_id.toString() === testSessionSpan.span_id.toString())
          ).to.be.true

          expect(
            testSuiteSpans.every(span => span.trace_id.toString() === testSessionSpan.trace_id.toString())
          ).to.be.true

          expect(testSuiteSpans.filter(span => span.meta[TEST_STATUS] === 'pass')).to.have.length(1)
          expect(testSuiteSpans.filter(span => span.meta[TEST_STATUS] === 'fail')).to.have.length(2)
          expect(testSuiteSpans.filter(span => span.meta[TEST_STATUS] === 'skip')).to.have.length(1)

          const failedTestSuite = testSuiteSpans.find(span => span.meta[TEST_STATUS] === 'fail')

          expect(failedTestSuite.meta[ERROR_MESSAGE]).to.equal(
            'Test "mocha-test-suite-level-fail will fail" failed with message "expected 2 to equal 8"'
          )
        }).then(() => done()).catch(done)

        const mocha = new Mocha({
          reporter: function () {} // silent on internal tests
        })
        mocha.addFile(testFilePath)
        mocha.addFile(testFilePathSecond)
        mocha.run()
      })
    })
  })
})
