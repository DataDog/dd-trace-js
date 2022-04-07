'use strict'
const path = require('path')
const { PassThrough } = require('stream')

const proxyquire = require('proxyquire').noPreserveCache()
const nock = require('nock')

const agent = require('../../dd-trace/test/plugins/agent')
const { ORIGIN_KEY } = require('../../dd-trace/src/constants')
const { SAMPLING_PRIORITY } = require('../../../ext/tags')
const { AUTO_KEEP } = require('../../../ext/priority')
const {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS,
  CI_APP_ORIGIN,
  ERROR_MESSAGE,
  TEST_SKIP_REASON,
  TEST_FRAMEWORK_VERSION
} = require('../../dd-trace/src/plugins/util/test')

const runCucumber = (version, Cucumber, requireName, featureName, testName) => {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
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
    stdout,
    stderr,
    env: process.env
  })

  return cli.run()
}

describe('Plugin', function () {
  let Cucumber
  this.timeout(10000)
  withVersions('cucumber', '@cucumber/cucumber', version => {
    afterEach(() => {
      // > If you want to run tests multiple times, you may need to clear Node's require cache
      // before subsequent calls in whichever manner best suits your needs.
      delete require.cache[require.resolve(path.join(__dirname, 'features', 'simple.js'))]
      return agent.close({ ritmReset: false })
    })
    beforeEach(() => {
      // for http integration tests
      nock('http://test:123')
        .get('/')
        .reply(200, 'OK')

      return agent.load(['cucumber', 'http']).then(() => {
        Cucumber = proxyquire(`../../../versions/@cucumber/cucumber@${version}`, {}).get()
      })
    })

    describe('cucumber', () => {
      describe('passing test', () => {
        it('should create a test span', async function () {
          const checkTraces = agent.use(traces => {
            expect(traces.length).to.equal(1)
            const testTrace = traces[0]
            expect(testTrace.length).to.equal(4)
            // take the test span
            const testSpan = testTrace.find(span => span.name === 'cucumber.test')
            // having no parent span means there is no span leak from other tests
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
            expect(testSpan.meta).to.contain({
              language: 'javascript',
              service: 'test',
              [TEST_NAME]: 'pass scenario',
              [TEST_TYPE]: 'test',
              [TEST_FRAMEWORK]: 'cucumber',
              [TEST_STATUS]: 'pass'
            })
            expect(testSpan.metrics).to.contain({
              [SAMPLING_PRIORITY]: AUTO_KEEP
            })
            expect(testSpan.meta[TEST_FRAMEWORK_VERSION]).not.to.be.undefined
            expect(testSpan.meta[TEST_SUITE].endsWith('simple.feature')).to.equal(true)
            expect(testSpan.type).to.equal('test')
            expect(testSpan.name).to.equal('cucumber.test')
            expect(testSpan.resource).to.equal('pass scenario')
          })
          const result = await runCucumber(version, Cucumber, 'simple.js', 'simple.feature', 'pass scenario')
          expect(result.success).to.equal(true)
          await checkTraces
        })
        it('should create spans for each cucumber step', async () => {
          const steps = [
            { name: 'datadog', stepStatus: 'pass' },
            { name: 'run', stepStatus: 'pass' },
            { name: 'pass', stepStatus: 'pass' }
          ]
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
          })
          const result = await runCucumber(version, Cucumber, 'simple.js', 'simple.feature', 'pass scenario')
          expect(result.success).to.equal(true)
          await checkTraces
        })
      })
      describe('failing test', () => {
        it('should create a test span', async function () {
          const checkTraces = agent.use(traces => {
            expect(traces.length).to.equal(1)
            const testTrace = traces[0]
            expect(testTrace.length).to.equal(4)
            // take the test span
            const testSpan = testTrace.find(span => span.name === 'cucumber.test')
            // having no parent span means there is no span leak from other tests
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
            expect(testSpan.meta).to.contain({
              language: 'javascript',
              service: 'test',
              [TEST_NAME]: 'fail scenario',
              [TEST_TYPE]: 'test',
              [TEST_FRAMEWORK]: 'cucumber',
              [TEST_STATUS]: 'fail'
            })
            expect(testSpan.meta[TEST_SUITE].endsWith('simple.feature')).to.equal(true)
            expect(testSpan.type).to.equal('test')
            expect(testSpan.name).to.equal('cucumber.test')
            expect(testSpan.resource).to.equal('fail scenario')
          })
          const result = await runCucumber(version, Cucumber, 'simple.js', 'simple.feature', 'fail scenario')
          expect(result.success).to.equal(false)
          await checkTraces
        })
        it('should create spans for each cucumber step', async () => {
          const steps = [
            { name: 'datadog', stepStatus: 'pass' },
            { name: 'run', stepStatus: 'pass' },
            { name: 'fail', stepStatus: 'fail' }
          ]
          const errors = ['AssertionError', undefined, undefined, 'AssertionError']
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
                testTrace[errorIndex].meta[ERROR_MESSAGE],
                `error ${errorIndex} should start with "${msg}"`
              ).to.satisfy(err => msg === undefined || err.startsWith(msg))
            })
          })
          const result = await runCucumber(version, Cucumber, 'simple.js', 'simple.feature', 'fail scenario')
          expect(result.success).to.equal(false)
          await checkTraces
        })
      })
      describe('skipped test', () => {
        it('should create a test span', async function () {
          const checkTraces = agent.use(traces => {
            expect(traces.length).to.equal(1)
            const testTrace = traces[0]
            expect(testTrace.length).to.equal(4)
            // take the test span
            const testSpan = testTrace.find(span => span.name === 'cucumber.test')
            // having no parent span means there is no span leak from other tests
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
            expect(testSpan.meta).to.contain({
              language: 'javascript',
              service: 'test',
              [TEST_NAME]: 'skip scenario',
              [TEST_TYPE]: 'test',
              [TEST_FRAMEWORK]: 'cucumber',
              [TEST_STATUS]: 'skip'
            })
            expect(testSpan.meta[TEST_SUITE].endsWith('simple.feature')).to.equal(true)
            expect(testSpan.type).to.equal('test')
            expect(testSpan.name).to.equal('cucumber.test')
            expect(testSpan.resource).to.equal('skip scenario')
          })
          const result = await runCucumber(version, Cucumber, 'simple.js', 'simple.feature', 'skip scenario')
          expect(result.success).to.equal(true)
          await checkTraces
        })
        it('should create spans for each cucumber step', async () => {
          const steps = [
            { name: 'datadog', stepStatus: 'pass' },
            { name: 'run', stepStatus: 'pass' },
            { name: 'skip', stepStatus: 'skip' }
          ]
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
          })
          const result = await runCucumber(version, Cucumber, 'simple.js', 'simple.feature', 'skip scenario')
          expect(result.success).to.equal(true)
          await checkTraces
        })
      })
      describe('skipped test based on tag', () => {
        it('should create a test span', async function () {
          const checkTraces = agent.use(traces => {
            expect(traces.length).to.equal(1)
            const testTrace = traces[0]
            expect(testTrace.length).to.equal(2)
            // take the test span
            const testSpan = testTrace.find(span => span.name === 'cucumber.test')
            // having no parent span means there is no span leak from other tests
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
            expect(testSpan.meta).to.contain({
              language: 'javascript',
              service: 'test',
              [TEST_NAME]: 'skip scenario based on tag',
              [TEST_TYPE]: 'test',
              [TEST_FRAMEWORK]: 'cucumber',
              [TEST_STATUS]: 'skip'
            })
            expect(testSpan.meta[TEST_SUITE].endsWith('simple.feature')).to.equal(true)
            expect(testSpan.type).to.equal('test')
            expect(testSpan.name).to.equal('cucumber.test')
            expect(testSpan.resource).to.equal('skip scenario based on tag')
          })
          const result = await runCucumber(
            version,
            Cucumber,
            'simple.js',
            'simple.feature',
            'skip scenario based on tag'
          )
          expect(result.success).to.equal(true)
          await checkTraces
        })
        it('should create spans for each cucumber step', async () => {
          const steps = [
            { name: 'datadog', stepStatus: 'skip' }
          ]
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
          })
          const result = await runCucumber(
            version,
            Cucumber,
            'simple.js',
            'simple.feature',
            'skip scenario based on tag'
          )
          expect(result.success).to.equal(true)
          await checkTraces
        })
      })
      describe('not implemented step', () => {
        it('should create a test span with a skip reason', async () => {
          const checkTraces = agent.use(traces => {
            expect(traces.length).to.equal(1)
            const testTrace = traces[0]
            expect(testTrace.length).to.equal(4)
            const testSpan = testTrace.find(span => span.name === 'cucumber.test')
            expect(testSpan.meta).to.contain({
              language: 'javascript',
              service: 'test',
              [TEST_NAME]: 'not implemented scenario',
              [TEST_TYPE]: 'test',
              [TEST_FRAMEWORK]: 'cucumber',
              [TEST_STATUS]: 'skip',
              [TEST_SKIP_REASON]: 'not implemented'
            })
            const notImplementedStepSpan = testTrace.find(span => span.meta['cucumber.step'] === 'not-implemented')
            expect(notImplementedStepSpan.meta).to.contain({
              [TEST_SKIP_REASON]: 'not implemented'
            })
            const implementedAndSkippedTestSpan = testTrace.find(span => span.meta['cucumber.step'] === 'pass')
            expect(implementedAndSkippedTestSpan.meta).not.to.contain({
              [TEST_SKIP_REASON]: 'not implemented'
            })
          })
          const result = await runCucumber(version, Cucumber, 'simple.js', 'simple.feature', 'not implemented scenario')
          expect(result.success).to.equal(false)
          await checkTraces
        })
      })
      describe('integration test', () => {
        it('should create a test span and a span for the integration', async function () {
          const checkTraces = agent.use(traces => {
            expect(traces.length).to.equal(1)
            const testTrace = traces[0]
            expect(testTrace.length).to.equal(5)
            // take the test span
            const testSpan = testTrace.find(span => span.name === 'cucumber.test')
            // having no parent span means there is no span leak from other tests
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
            expect(testSpan.meta).to.contain({
              language: 'javascript',
              service: 'test',
              [TEST_NAME]: 'integration scenario',
              [TEST_TYPE]: 'test',
              [TEST_FRAMEWORK]: 'cucumber',
              [TEST_STATUS]: 'pass'
            })
            expect(testSpan.meta[TEST_SUITE].endsWith('simple.feature')).to.equal(true)
            expect(testSpan.type).to.equal('test')
            expect(testSpan.name).to.equal('cucumber.test')
            expect(testSpan.resource).to.equal('integration scenario')
            const httpSpan = testTrace.find(span => span.name === 'http.request')
            expect(httpSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
            expect(httpSpan.meta['http.url']).to.equal('http://test:123/')
            const parentCucumberStep = testTrace.find(span => span.meta['cucumber.step'] === 'integration')
            expect(httpSpan.parent_id.toString()).to.equal(parentCucumberStep.span_id.toString())
          })
          const result = await runCucumber(version, Cucumber, 'simple.js', 'simple.feature', 'integration scenario')
          expect(result.success).to.equal(true)
          await checkTraces
        })
        it('should create spans for each cucumber step', async () => {
          const steps = [
            { name: 'datadog', stepStatus: 'pass' },
            { name: 'integration', stepStatus: 'pass' },
            { name: 'pass', stepStatus: 'pass' }
          ]
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
          })
          const result = await runCucumber(version, Cucumber, 'simple.js', 'simple.feature', 'integration scenario')
          expect(result.success).to.equal(true)
          await checkTraces
        })
      })
      describe('hook fail', () => {
        it('should create a test span', async function () {
          const checkTraces = agent.use(traces => {
            expect(traces.length).to.equal(1)
            const testTrace = traces[0]
            expect(testTrace.length).to.equal(4)
            // take the test span
            const testSpan = testTrace.find(span => span.name === 'cucumber.test')
            // having no parent span means there is no span leak from other tests
            expect(testSpan.parent_id.toString()).to.equal('0')
            expect(testSpan.meta[ORIGIN_KEY]).to.equal(CI_APP_ORIGIN)
            expect(testSpan.meta).to.contain({
              language: 'javascript',
              service: 'test',
              [TEST_NAME]: 'hooks fail',
              [TEST_TYPE]: 'test',
              [TEST_FRAMEWORK]: 'cucumber',
              [TEST_STATUS]: 'fail'
            })
            expect(testSpan.meta[TEST_SUITE].endsWith('simple.feature')).to.equal(true)
            expect(testSpan.type).to.equal('test')
            expect(testSpan.name).to.equal('cucumber.test')
            expect(testSpan.resource).to.equal('hooks fail')
            expect(
              testSpan.meta[ERROR_MESSAGE].startsWith(`TypeError: Cannot set property 'boom' of undefined`) ||
              testSpan.meta[ERROR_MESSAGE].startsWith(`TypeError: Cannot set properties of undefined (setting 'boom')`)
            ).to.equal(true)
          })
          const result = await runCucumber(version, Cucumber, 'simple.js', 'simple.feature', 'hooks fail')
          expect(result.success).to.equal(false)
          await checkTraces
        })
        it('should create spans for each cucumber step', async () => {
          const steps = [
            { name: 'datadog', stepStatus: 'skip' },
            { name: 'run', stepStatus: 'skip' },
            { name: 'pass', stepStatus: 'skip' }
          ]
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
          })
          const result = await runCucumber(version, Cucumber, 'simple.js', 'simple.feature', 'hooks fail')
          expect(result.success).to.equal(false)
          await checkTraces
        })
      })
    })
  })
})
