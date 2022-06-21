'use strict'
const getPort = require('get-port')
const { expect } = require('chai')
const semver = require('semver')

const agent = require('../../dd-trace/test/plugins/agent')
const appServer = require('./app/app-server')
const { ORIGIN_KEY } = require('../../dd-trace/src/constants')
const {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_SOURCE_FILE,
  TEST_STATUS,
  TEST_IS_RUM_ACTIVE,
  CI_APP_ORIGIN,
  ERROR_TYPE,
  ERROR_MESSAGE,
  TEST_FRAMEWORK_VERSION,
  TEST_CODE_OWNERS,
  LIBRARY_VERSION
} = require('../../dd-trace/src/plugins/util/test')

const { version: ddTraceVersion } = require('../../../package.json')

describe('Plugin', function () {
  let cypressExecutable
  let appPort
  let agentListenPort
  withVersions('cypress', 'cypress', (version, moduleName) => {
    beforeEach(function () {
      this.timeout(10000)
      return agent.load().then(() => {
        agentListenPort = agent.server.address().port
        cypressExecutable = require(`../../../versions/cypress@${version}`).get()
        return getPort().then(port => {
          appPort = port
          appServer.listen(appPort)
        })
      })
    })
    afterEach(() => agent.close({ ritmReset: false }))
    afterEach(done => appServer.close(done))

    describe('cypress', function () {
      this.timeout(120000)
      it('instruments tests', function (done) {
        process.env.DD_TRACE_AGENT_PORT = agentListenPort
        cypressExecutable.run({
          project: semver.intersects(version, '>=10')
            ? './packages/datadog-plugin-cypress/test/app-10' : './packages/datadog-plugin-cypress/test/app',
          config: {
            baseUrl: `http://localhost:${appPort}`
          },
          quiet: true
        })
        const passingTestPromise = agent
          .use(traces => {
            const testSpan = traces[0][0]
            expect(testSpan.name).to.equal('cypress.test')
            expect(testSpan.resource).to.equal(
              'cypress/integration/integration-test.js.can visit a page renders a hello world'
            )
            expect(testSpan.type).to.equal('test')
            expect(testSpan.meta).to.contain({
              language: 'javascript',
              addTags: 'custom',
              addTagsBeforeEach: 'custom',
              addTagsAfterEach: 'custom',
              [TEST_FRAMEWORK]: 'cypress',
              [TEST_NAME]: 'can visit a page renders a hello world',
              [TEST_STATUS]: 'pass',
              [TEST_SUITE]: 'cypress/integration/integration-test.js',
              [TEST_SOURCE_FILE]: 'cypress/integration/integration-test.js',
              [TEST_TYPE]: 'test',
              [ORIGIN_KEY]: CI_APP_ORIGIN,
              [TEST_IS_RUM_ACTIVE]: 'true',
              [TEST_CODE_OWNERS]: JSON.stringify(['@datadog']),
              [LIBRARY_VERSION]: ddTraceVersion
            })
            expect(testSpan.meta[TEST_FRAMEWORK_VERSION]).not.to.be.undefined
          })
        const failingTestPromise = agent
          .use(traces => {
            const testSpan = traces[0][0]
            expect(testSpan.name).to.equal('cypress.test')
            expect(testSpan.resource).to.equal(
              'cypress/integration/integration-test.js.can visit a page will fail'
            )
            expect(testSpan.type).to.equal('test')
            expect(testSpan.meta).to.contain({
              language: 'javascript',
              addTags: 'custom',
              addTagsBeforeEach: 'custom',
              addTagsAfterEach: 'custom',
              [TEST_FRAMEWORK]: 'cypress',
              [TEST_NAME]: 'can visit a page will fail',
              [TEST_STATUS]: 'fail',
              [TEST_SUITE]: 'cypress/integration/integration-test.js',
              [TEST_SOURCE_FILE]: 'cypress/integration/integration-test.js',
              [TEST_TYPE]: 'test',
              [ORIGIN_KEY]: CI_APP_ORIGIN,
              [ERROR_TYPE]: 'AssertionError',
              [TEST_IS_RUM_ACTIVE]: 'true'
            })
            expect(testSpan.meta).to.not.contain({
              addTagsAfterFailure: 'custom'
            })
            expect(testSpan.meta[ERROR_MESSAGE]).to.contain(
              "expected '<div.hello-world>' to have text 'Bye World', but the text was 'Hello World'"
            )
          })
        Promise.all([passingTestPromise, failingTestPromise]).then(() => done()).catch(done)
      })
    })
  })
})
