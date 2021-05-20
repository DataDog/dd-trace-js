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
    testStatus: 'pass',
    steps: [
      { name: 'datadog', stepStatus: 'pass' },
      { name: 'run', stepStatus: 'pass' },
      { name: 'pass', stepStatus: 'pass' }
    ],
    success: true
  },
  {
    featureName: 'simple.feature',
    featureSuffix: ':8',
    requireName: 'simple.js',
    testName: 'fail scenario',
    testStatus: 'fail',
    steps: [
      { name: 'datadog', stepStatus: 'pass' },
      { name: 'run', stepStatus: 'pass' },
      { name: 'fail', stepStatus: 'fail' }
    ],
    success: false,
    errors: [undefined, undefined, 'AssertionError', 'AssertionError']
  },
  {
    featureName: 'simple.feature',
    featureSuffix: ':13',
    requireName: 'simple.js',
    testName: 'skip scenario',
    testStatus: 'skip',
    steps: [
      { name: 'datadog', stepStatus: 'pass' },
      { name: 'run', stepStatus: 'pass' },
      { name: 'skip', stepStatus: 'skip' }
    ],
    success: true,
    errors: [undefined, undefined, 'skipped', 'skipped']
  },
  {
    featureName: 'simple.feature',
    featureSuffix: ':19',
    requireName: 'simple.js',
    testName: 'skip scenario based on tag',
    testStatus: 'skip',
    steps: [{ name: 'datadog', stepStatus: 'skip' }],
    success: true,
    errors: ['skipped', 'skipped']
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
        it(`should create a test span for ${test.featureName}${test.featureSuffix || ''}`, async function () {
          this.timeout(20000)
          const testFilePath = path.join(__dirname, 'features', test.featureName)
          const testSuite = testFilePath.replace(`${process.cwd()}/`, '')
          const checkTraces = agent
            .use(traces => {
              // number of tests + one test span
              expect(traces[0].length).to.equal(test.steps.length + 1)
              if (test.errors !== undefined) {
                test.errors.forEach((msg, i) => {
                  expect(
                    traces[0][i].meta['error.msg'],
                    `item ${i} should start with "${msg}"`
                  ).to.satisfy(err => msg === undefined || err.startsWith(msg))
                })
              }
              // take the test span
              const testSpan = traces[0][traces[0].length - 1]
              expect(traces[0][traces[0].length - 1].meta).to.contain({
                language: 'javascript',
                service: 'test',
                [TEST_NAME]: test.testName,
                [TEST_TYPE]: 'test',
                [TEST_FRAMEWORK]: 'cucumber',
                [TEST_SUITE]: testSuite,
                [TEST_STATUS]: test.testStatus
              })
              expect(testSpan.meta[TEST_SUITE].endsWith(test.featureName)).to.equal(true)
              expect(testSpan.type).to.equal('test')
              expect(testSpan.name).to.equal('cucumber.test')
              expect(testSpan.resource).to.equal(`${test.testName}`)
              // step spans
              const stepSpans = traces[0].filter(span => span.name === 'cucumber.step')
              expect(stepSpans.length).to.equal(test.steps.length)
              stepSpans.forEach((stepSpan, index) => {
                // all steps are children of the test span
                expect(stepSpan.parent_id.toString()).to.equal(testSpan.span_id.toString())
                expect(stepSpan.meta['cucumber.step']).to.equal(test.steps[index].name)
                expect(stepSpan.meta['step.status']).to.equal(test.steps[index].stepStatus)
                expect(stepSpan.type).not.to.equal('test')
              })
            })

          const stdout = new PassThrough()
          const cwd = path.resolve(path.join(__dirname, `../../../versions/@cucumber/cucumber@${version}`))
          const cucumberJs = `${cwd}/node-modules/.bin/cucumber-js`
          const argv = [
            'node',
            cucumberJs,
            '--require',
            path.join(__dirname, 'features', test.requireName),
            path.join(__dirname, 'features', `${test.featureName}${test.featureSuffix || ''}`)
          ]
          const cli = new Cucumber.Cli({
            argv, cwd, stdout
          })

          const result = await cli.run()
          expect(result.success).to.equal(test.success)
          await checkTraces
        })
      })
    })
  })
})
