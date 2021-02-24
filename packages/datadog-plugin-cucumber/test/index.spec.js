'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')


const {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS
} = require('../../dd-trace/src/plugins/util/test')
const { expect } = require('chai')
const path = require('path')
const { PassThrough } = require('stream')

const TESTS = [
  {
    featureName: 'simple.feature',
    featureSuffix: ':3',
    requireName: 'simple.js',
    testName: 'pass scenario',
    status: 'pass',
    success: true
  },
  {
    featureName: 'simple.feature',
    featureSuffix: ':8',
    requireName: 'simple.js',
    testName: 'fail scenario',
    status: 'fail',
    success: false
  },
  {
    featureName: 'simple.feature',
    featureSuffix: ':13',
    requireName: 'simple.js',
    testName: 'skip scenario',
    status: 'skip',
    success: true
  },
  {
    featureName: 'simple.feature',
    featureSuffix: ':19',
    requireName: 'simple.js',
    testName: 'skip scenario based on tag',
    status: 'skip',
    success: true
  }
]

wrapIt()

describe('Plugin', () => {
  let Cucumber

  withVersions(plugin, '@cucumber/cucumber', version => {
    afterEach(() => {
      // > If you want to run tests multiple times, you may need to clear Node's require cache
      // before subsequent calls in whichever manner best suits your needs.
      TESTS.forEach((test) => {
        delete require.cache[require.resolve(path.join(__dirname, 'features', test.requireName))]
      })
      return agent.close()
    })
    beforeEach(() => {
      return agent.load('cucumber').then(() => {
        Cucumber = require(`../../../versions/@cucumber/cucumber@${version}`).get()
      })
    })

    describe('cucumber', () => {
      TESTS.forEach(test => {
        it(`should create a test span for ${test.featureName}${test.featureSuffix || ''}`, function (done) {
          this.timeout(20000)
          const testFilePath = path.join(__dirname, 'features', test.featureName)
          const testSuite = testFilePath.replace(`${process.cwd()}/`, '')
          agent
            .use(traces => {
              // take the last top level trace
              const trace = traces[0][traces[0].length-1]
              expect(traces[0][traces[0].length-1].meta).to.contain({
                language: 'javascript',
                service: 'test',
                [TEST_NAME]: test.testName,
                [TEST_STATUS]: test.status,
                [TEST_TYPE]: 'test',
                [TEST_FRAMEWORK]: 'cucumber',
                [TEST_SUITE]: testSuite
              })
              expect(trace.meta[TEST_SUITE].endsWith(test.featureName)).to.equal(true)
              expect(trace.type).to.equal('test')
              expect(trace.name).to.equal('cucumber.test')
              expect(trace.resource).to.equal(`${test.testName}`)
            }).then(done, done)

          const stdout = new PassThrough()
          const cwd = path.resolve(path.join(__dirname, `../../../versions/@cucumber/cucumber@${version}`))
          const cucumber_js = `${cwd}/node-modules/.bin/cucumber-js`;
          const argv = [
            'node',
            cucumber_js,
            '--require', __dirname + '/features/' + test.requireName,
            __dirname + '/features/' + test.featureName + test.featureSuffix
          ]
          const cli = new Cucumber.Cli({
            argv, cwd, stdout
          });

          cli.run().then(result => {
            expect(result.success).to.equal(test.success)
          }, reason => {
            throw reason
          })
        })
      })
    })
  })
})
