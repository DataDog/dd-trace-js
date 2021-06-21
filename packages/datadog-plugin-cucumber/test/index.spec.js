'use strict'
const path = require('path')
const { PassThrough } = require('stream')

const nock = require('nock')

const agent = require('../../dd-trace/test/plugins/agent')
const { ORIGIN_KEY } = require('../../dd-trace/src/constants')
const plugin = require('../src')
const {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS,
  CI_APP_ORIGIN
} = require('../../dd-trace/src/plugins/util/test')

const TESTS = [
  {
    featureName: 'simple.feature',
    requireName: 'simple.js',
    testName: 'pass scenario',
    testStatus: 'pass',
    steps: [
      { name: 'datadog', stepStatus: 'pass' },
      { name: 'run', stepStatus: 'pass' },
      { name: 'pass', stepStatus: 'pass' }
    ],
    success: true,
    errors: []
  },
  {
    featureName: 'simple.feature',
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
    requireName: 'simple.js',
    testName: 'skip scenario based on tag',
    testStatus: 'skip',
    steps: [{ name: 'datadog', stepStatus: 'skip' }],
    success: true,
    errors: ['skipped', 'skipped']
  },
  {
    featureName: 'simple.feature',
    requireName: 'simple.js',
    testName: 'integration scenario',
    testStatus: 'pass',
    steps: [
      { name: 'datadog', stepStatus: 'pass' },
      { name: 'integration', stepStatus: 'pass' },
      { name: 'pass', stepStatus: 'pass' }
    ],
    success: true,
    errors: []
  }
]

wrapIt()

const runCucumber = (version, Cucumber, requireName, featureName, testName) => {
  const stdout = new PassThrough()
  const cwd = path.resolve(path.join(__dirname, `../../../versions/@cucumber/cucumber@${version}`))
  const cucumberJs = `${cwd}/node-modules/.bin/cucumber-js`
  const argv = [
    'node',
    cucumberJs,
    '--require',
    path.join(__dirname, 'features', requireName),
    path.join(__dirname, 'features', featureName),
    '--name',
    testName
  ]
  const cli = new Cucumber.Cli({
    argv,
    cwd,
    stdout
  })

  return cli.run()
}

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
      // for http integration tests
      nock('http://test:123')
        .get('/')
        .reply(200, 'OK')

      return agent.load(['cucumber', 'http']).then(() => {
        Cucumber = require(`../../../versions/@cucumber/cucumber@${version}`).get()
      })
    })

    describe('cucumber', () => {
      TESTS.forEach(test => {
        const testFilePath = path.join(__dirname, 'features', test.featureName)
        const testSuite = testFilePath.replace(`${process.cwd()}/`, '')
        const {
          featureName,
          requireName,
          testName,
          testStatus,
          steps,
          success,
          errors
        } = test

        describe(`for ${featureName}${testName}`, () => {
          it('should create a test span and spans for integrations', async function () {
            const checkTraces = agent.use(traces => {
              expect(traces.length).to.equal(1)
              const testTrace = traces[0]
              const isIntegrationTest = testName === 'integration scenario'
              // number of tests + one test span + possibly one http span
              const numExpectedSpans = steps.length + (isIntegrationTest ? 2 : 1)
              expect(testTrace.length).to.equal(numExpectedSpans)
              // take the test span
              const testSpan = testTrace.find(span => span.name === 'cucumber.test')
              // having no parent span means there is no span leak from other tests
              expect(testSpan.parent_id.toString()).to.equal('0')
              expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
              expect(testSpan.meta).to.contain({
                language: 'javascript',
                service: 'test',
                [TEST_NAME]: testName,
                [TEST_TYPE]: 'test',
                [TEST_FRAMEWORK]: 'cucumber',
                [TEST_SUITE]: testSuite,
                [TEST_STATUS]: testStatus
              })
              expect(testSpan.meta[TEST_SUITE].endsWith(featureName)).to.equal(true)
              expect(testSpan.type).to.equal('test')
              expect(testSpan.name).to.equal('cucumber.test')
              expect(testSpan.resource).to.equal(testName)
              if (isIntegrationTest) {
                const httpSpan = testTrace.find(span => span.name === 'http.request')
                expect(httpSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
                expect(httpSpan.meta['http.url']).to.equal('http://test:123/')
                const parentCucumberStep = testTrace.find(span => span.meta['cucumber.step'] === 'integration')
                expect(httpSpan.parent_id.toString()).to.equal(parentCucumberStep.span_id.toString())
              }
            })
            const result = await runCucumber(version, Cucumber, requireName, featureName, testName)
            expect(result.success).to.equal(success)
            await checkTraces
          })

          it('should create spans for each cucumber step', async () => {
            const checkTraces = agent.use(traces => {
              const testTrace = traces[0]
              const testSpan = testTrace.find(span => span.name === 'cucumber.test')
              // step spans
              const stepSpans = testTrace.filter(span => span.name === 'cucumber.step')
              expect(stepSpans.length).to.equal(steps.length)
              stepSpans.forEach((stepSpan, spanIndex) => {
                // children spans should carry _dd.origin
                expect(stepSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
                // all steps are children of the test span
                expect(stepSpan.parent_id.toString()).to.equal(testSpan.span_id.toString())
                expect(stepSpan.meta['cucumber.step']).to.equal(steps[spanIndex].name)
                expect(stepSpan.meta['step.status']).to.equal(steps[spanIndex].stepStatus)
                expect(stepSpan.type).not.to.equal('test')
              })
              errors.forEach((msg, errorIndex) => {
                expect(
                  testTrace[errorIndex].meta['error.msg'],
                  `error ${errorIndex} should start with "${msg}"`
                ).to.satisfy(err => msg === undefined || err.startsWith(msg))
              })
            })
            const result = await runCucumber(version, Cucumber, requireName, featureName, testName)
            expect(result.success).to.equal(success)
            await checkTraces
          })
        })
      })
    })
  })
})
