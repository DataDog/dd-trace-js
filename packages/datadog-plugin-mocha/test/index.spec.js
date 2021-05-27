'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { ORIGIN_KEY } = require('../../dd-trace/src/constants')
const plugin = require('../src')
const {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS,
  TEST_PARAMETERS,
  ERROR_TYPE,
  ERROR_MESSAGE,
  ERROR_STACK,
  CI_APP_ORIGIN
} = require('../../dd-trace/src/plugins/util/test')
const { expect } = require('chai')
const path = require('path')

const TESTS = [
  {
    fileName: 'mocha-test-pass.js',
    testNames: [
      'mocha-test-pass can pass',
      'mocha-test-pass can pass two',
      'mocha-test-pass-two can pass',
      'mocha-test-pass-two can pass two'
    ],
    status: 'pass'
  },
  {
    fileName: 'mocha-test-fail.js',
    testName: 'can fail',
    root: 'mocha-test-fail',
    status: 'fail'
  },
  {
    fileName: 'mocha-test-skip.js',
    testNames: [
      'mocha-test-skip can skip',
      'mocha-test-skip-different can skip too',
      'mocha-test-skip-different can skip twice'
    ],
    status: 'skip'
  },
  {
    fileName: 'mocha-test-done-pass.js',
    testName: 'can do passed tests with done',
    root: 'mocha-test-done-pass',
    status: 'pass'
  },
  {
    fileName: 'mocha-test-integration.js',
    testName: 'can do integration tests',
    root: 'mocha-test-integration',
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
  },
  {
    fileName: 'mocha-test-parameterized.js',
    testName: 'can do parameterized',
    root: 'mocha-parameterized',
    status: 'pass',
    extraSpanTags: {
      [TEST_PARAMETERS]: JSON.stringify({ arguments: [1, 2, 3], metadata: {} })
    }
  }
]

describe('Plugin', () => {
  let Mocha
  withVersions(plugin, 'mocha', version => {
    afterEach(() => {
      // This needs to be done when using the programmatic API:
      // https://github.com/mochajs/mocha/wiki/Using-Mocha-programmatically
      // > If you want to run tests multiple times, you may need to clear Node's require cache
      // before subsequent calls in whichever manner best suits your needs.
      TESTS.forEach((test) => {
        delete require.cache[require.resolve(path.join(__dirname, test.fileName))]
      })
      return agent.close()
    })
    beforeEach(() => {
      return agent.load(['mocha', 'fs']).then(() => {
        Mocha = require(`../../../versions/mocha@${version}`).get()
      })
    })

    describe('mocha', () => {
      TESTS.forEach(test => {
        it(`should create a test span for ${test.fileName}`, (done) => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()
          const testFilePath = path.join(__dirname, test.fileName)
          const testSuite = testFilePath.replace(`${process.cwd()}/`, '')

          if (test.fileName === 'mocha-test-skip.js' || test.fileName === 'mocha-test-pass.js') {
            const assertionPromises = test.testNames.map(testName => {
              return agent.use(trace => {
                const testSpan = trace[0][0]
                expect(testSpan.parent_id.toString()).to.equal('0')
                expect(testSpan.meta[TEST_STATUS]).to.equal(test.status)
                expect(testSpan.meta[TEST_NAME]).to.equal(testName)
                expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
              })
            })
            Promise.all(assertionPromises)
              .then(() => done())
              .catch(done)
          } else if (test.fileName === 'mocha-test-integration.js') {
            agent.use(trace => {
              const testSpan = trace[0].find(span => span.type === 'test')
              const fsOperationSpan = trace[0].find(span => span.name === 'fs.operation')
              expect(testSpan.parent_id.toString()).to.equal('0')
              expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
              expect(testSpan.meta[TEST_STATUS]).to.equal('pass')
              expect(testSpan.meta[TEST_NAME]).to.equal('mocha-test-integration can do integration tests')
              expect(fsOperationSpan.parent_id.toString()).to.equal(testSpan.span_id.toString())
              expect(fsOperationSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
            }).then(done, done)
          } else {
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
                  ...test.extraSpanTags
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
          }

          const mocha = new Mocha({
            reporter: function () {} // silent on internal tests
          })
          mocha.addFile(testFilePath)
          mocha.run()
        })
      })
    })
  })
})
