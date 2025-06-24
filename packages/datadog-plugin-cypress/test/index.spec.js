'use strict'
const { expect } = require('chai')
const semver = require('semver')

const agent = require('../../dd-trace/test/plugins/agent')
const appServer = require('./app/app-server')
const { ORIGIN_KEY, COMPONENT, ERROR_MESSAGE, ERROR_TYPE } = require('../../dd-trace/src/constants')
const {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_SOURCE_FILE,
  TEST_SOURCE_START,
  TEST_STATUS,
  TEST_IS_RUM_ACTIVE,
  CI_APP_ORIGIN,
  TEST_FRAMEWORK_VERSION,
  TEST_CODE_OWNERS,
  LIBRARY_VERSION
} = require('../../dd-trace/src/plugins/util/test')

const { version: ddTraceVersion } = require('../../../package.json')

const testTimeout = 60000

describe('Plugin', function () {
  let cypressExecutable
  let appPort
  let agentListenPort
  this.retries(2)
  withVersions('cypress', 'cypress', (version, moduleName) => {
    beforeEach(() => {
      return agent.load()
    })
    beforeEach(function (done) {
      // This test does not check test optimization agentless protocol,
      // so we'll make the tracer default to reporting to v0.4/traces
      agent.setAvailableEndpoints([])
      this.timeout(10000)
      agentListenPort = agent.server.address().port
      cypressExecutable = require(`../../../versions/cypress@${version}`).get()
      appServer.listen(0, () => {
        appPort = appServer.address().port
        done()
      })
    })
    afterEach(() => agent.close({ ritmReset: false }))
    afterEach(done => {
      appServer.close(done)
    })

    describe('cypress', function () {
      this.timeout(testTimeout)

      it('instruments tests', function (done) {
        process.env.DD_TRACE_AGENT_PORT = agentListenPort
        const testSuiteFolder = semver.intersects(version, '>=10')
          ? 'app-10'
          : 'app'

        cypressExecutable.run({
          project: `./packages/datadog-plugin-cypress/test/${testSuiteFolder}`,
          config: {
            baseUrl: `http://localhost:${appPort}`
          },
          quiet: true,
          headless: true
        })

        agent.assertSomeTraces(traces => {
          const passedTestSpan = traces[0][0]
          const failedTestSpan = traces[1][0]
          expect(passedTestSpan.name).to.equal('cypress.test')
          expect(passedTestSpan.resource).to.equal(
            'cypress/integration/integration-test.js.can visit a page renders a hello world'
          )
          expect(passedTestSpan.type).to.equal('test')
          expect(passedTestSpan.meta).to.contain({
            language: 'javascript',
            addTags: 'custom',
            addTagsBeforeEach: 'custom',
            addTagsAfterEach: 'custom',
            [TEST_FRAMEWORK]: 'cypress',
            [TEST_NAME]: 'can visit a page renders a hello world',
            [TEST_STATUS]: 'pass',
            [TEST_SUITE]: 'cypress/integration/integration-test.js',
            [TEST_SOURCE_FILE]:
              `packages/datadog-plugin-cypress/test/${testSuiteFolder}/cypress/integration/integration-test.js`,
            [TEST_TYPE]: 'browser',
            [ORIGIN_KEY]: CI_APP_ORIGIN,
            [TEST_IS_RUM_ACTIVE]: 'true',
            [LIBRARY_VERSION]: ddTraceVersion,
            [COMPONENT]: 'cypress'
          })
          expect(passedTestSpan.meta[TEST_CODE_OWNERS]).to.contain('@DataDog')
          expect(passedTestSpan.meta[TEST_FRAMEWORK_VERSION]).not.to.be.undefined
          expect(passedTestSpan.metrics[TEST_SOURCE_START]).to.exist

          expect(failedTestSpan.name).to.equal('cypress.test')
          expect(failedTestSpan.resource).to.equal(
            'cypress/integration/integration-test.js.can visit a page will fail'
          )
          expect(failedTestSpan.type).to.equal('test')
          expect(failedTestSpan.meta).to.contain({
            language: 'javascript',
            addTags: 'custom',
            addTagsBeforeEach: 'custom',
            addTagsAfterEach: 'custom',
            [TEST_FRAMEWORK]: 'cypress',
            [TEST_NAME]: 'can visit a page will fail',
            [TEST_STATUS]: 'fail',
            [TEST_SUITE]: 'cypress/integration/integration-test.js',
            [TEST_SOURCE_FILE]:
              `packages/datadog-plugin-cypress/test/${testSuiteFolder}/cypress/integration/integration-test.js`,
            [TEST_TYPE]: 'browser',
            [ORIGIN_KEY]: CI_APP_ORIGIN,
            [ERROR_TYPE]: 'AssertionError',
            [TEST_IS_RUM_ACTIVE]: 'true',
            [COMPONENT]: 'cypress'
          })
          expect(failedTestSpan.meta).to.not.contain({
            addTagsAfterFailure: 'custom'
          })
          expect(failedTestSpan.meta[ERROR_MESSAGE]).to.contain(
            "expected '<div.hello-world>' to have text 'Bye World', but the text was 'Hello World'"
          )
          expect(failedTestSpan.metrics[TEST_SOURCE_START]).to.exist
        }, { timeoutMs: testTimeout }).then(() => done()).catch(done)
      })
    })
  })
})
