'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
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
  ERROR_STACK
} = require('../../dd-trace/src/plugins/util/test')
const { expect } = require('chai')
const path = require('path')

const TESTS = [
  // {
  //   fileName: 'mocha-test-pass.js',
  //   testName: 'can pass',
  //   root: 'mocha-test-pass',
  //   status: 'pass'
  // },
  // {
  //   fileName: 'mocha-test-fail.js',
  //   testName: 'can fail',
  //   root: 'mocha-test-fail',
  //   status: 'fail'
  // },
  {
    fileName: 'mocha-test-skip.js',
    testName: 'can skip',
    root: 'mocha-test-skip',
    status: 'skip'
  },
  // {
  //   fileName: 'mocha-test-done-pass.js',
  //   testName: 'can do passed tests with done',
  //   root: 'mocha-test-done-pass',
  //   status: 'pass'
  // },
  // {
  //   fileName: 'mocha-test-done-fail.js',
  //   testName: 'can do failed tests with done',
  //   root: 'mocha-test-done-fail',
  //   status: 'fail'
  // },
  // {
  //   fileName: 'mocha-test-promise-pass.js',
  //   testName: 'can do passed promise tests',
  //   root: 'mocha-test-promise-pass',
  //   status: 'pass'
  // },
  // {
  //   fileName: 'mocha-test-promise-fail.js',
  //   testName: 'can do failed promise tests',
  //   root: 'mocha-test-promise-fail',
  //   status: 'fail'
  // },
  // {
  //   fileName: 'mocha-test-async-pass.js',
  //   testName: 'can do passed async tests',
  //   root: 'mocha-test-async-pass',
  //   status: 'pass'
  // },
  // {
  //   fileName: 'mocha-test-async-fail.js',
  //   testName: 'can do failed async tests',
  //   root: 'mocha-test-async-fail',
  //   status: 'fail'
  // },
  // {
  //   fileName: 'mocha-test-timeout-fail.js',
  //   testName: 'times out',
  //   root: 'mocha-test-timeout-fail',
  //   status: 'fail'
  // },
  // {
  //   fileName: 'mocha-test-timeout-pass.js',
  //   testName: 'does not timeout',
  //   root: 'mocha-test-timeout-pass',
  //   status: 'pass'
  // },
  // {
  //   fileName: 'mocha-test-parameterized.js',
  //   testName: 'can do parameterized',
  //   root: 'mocha-parameterized',
  //   status: 'pass',
  //   extraSpanTags: {
  //     [TEST_PARAMETERS]: JSON.stringify({ arguments: [1, 2, 3], metadata: {} })
  //   }
  // }
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
      debugger
      return agent.load('mocha', {}, { flushInterval: 100000000 }).then(() => {
        Mocha = require(`../../../versions/mocha@${version}`).get()
      })
    })

    describe('mocha', () => {
      TESTS.forEach(test => {
        it(`should create a test span for ${test.fileName}`, (done) => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()
          const testFilePath = path.join(__dirname, test.fileName)
          const testSuite = testFilePath.replace(`${process.cwd()}/`, '')
          agent
            .use(traces => {
              expect(traces.length).to.equal(3)
              // expect(traces[0][0].meta).to.contain({
              //   language: 'javascript',
              //   service: 'test',
              //   [TEST_NAME]: `${test.root} ${test.testName}`,
              //   [TEST_STATUS]: test.status,
              //   [TEST_TYPE]: 'test',
              //   [TEST_FRAMEWORK]: 'mocha',
              //   [TEST_SUITE]: testSuite,
              //   ...test.extraSpanTags
              // })
              // if (test.fileName === 'mocha-test-fail.js') {
              //   expect(traces[0][0].meta).to.contain({
              //     [ERROR_TYPE]: 'AssertionError',
              //     [ERROR_MESSAGE]: 'expected true to equal false'
              //   })
              //   expect(traces[0][0].meta[ERROR_STACK]).not.to.be.undefined
              // }
              // expect(traces[0][0].meta[TEST_SUITE].endsWith(test.fileName)).to.equal(true)
              // expect(traces[0][0].type).to.equal('test')
              // expect(traces[0][0].name).to.equal('mocha.test')
              // expect(traces[0][0].resource).to.equal(`${testSuite}.${test.root} ${test.testName}`)
            }).then(done, done)

          const mocha = new Mocha({
            reporter: function () {} // silent on internal tests
          })
          mocha.addFile(testFilePath)
          mocha.run(() => {
            agent.flush()
          })
        })
      })
    })
  })
})
