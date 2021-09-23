'use strict'
const getPort = require('get-port')
const { expect } = require('chai')

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')
const appServer = require('./app/app-server')
const { ORIGIN_KEY } = require('../../dd-trace/src/constants')
const {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS,
  CI_APP_ORIGIN,
  ERROR_TYPE,
  ERROR_MESSAGE
} = require('../../dd-trace/src/plugins/util/test')

describe('Plugin', () => {
  let cypressExecutable
  let appPort
  let agentListenPort
  withVersions(plugin, ['cypress'], (version, moduleName) => {
    beforeEach(() => {
      return agent.load().then(() => {
        agentListenPort = agent.server.address().port
        cypressExecutable = require(`../../../versions/cypress@${version}`).get()
        return getPort().then(port => {
          appPort = port
          appServer.listen(appPort)
        })
      })
    })
    afterEach(() => agent.close())
    afterEach(done => appServer.close(done))

    describe('cypress', function () {
      this.timeout(60000)
      it('instruments tests', function (done) {
        process.env.DD_TRACE_AGENT_PORT = agentListenPort
        cypressExecutable.run({
          project: './packages/datadog-plugin-cypress/test/app',
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
              [TEST_FRAMEWORK]: 'cypress',
              [TEST_NAME]: 'can visit a page renders a hello world',
              [TEST_STATUS]: 'pass',
              [TEST_SUITE]: 'cypress/integration/integration-test.js',
              [TEST_TYPE]: 'test',
              [ORIGIN_KEY]: CI_APP_ORIGIN
            })
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
              [TEST_FRAMEWORK]: 'cypress',
              [TEST_NAME]: 'can visit a page will fail',
              [TEST_STATUS]: 'fail',
              [TEST_SUITE]: 'cypress/integration/integration-test.js',
              [TEST_TYPE]: 'test',
              [ORIGIN_KEY]: CI_APP_ORIGIN,
              [ERROR_TYPE]: 'AssertionError'
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
