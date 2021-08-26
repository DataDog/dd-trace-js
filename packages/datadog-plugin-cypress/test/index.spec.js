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
  CI_APP_ORIGIN
} = require('../../dd-trace/src/plugins/util/test')

describe('Plugin', () => {
  let cypressExecutable
  let appPort
  let agentListenPort
  withVersions(plugin, ['cypress'], (version, moduleName) => {
    beforeEach(() => {
      return agent.load(['cypress']).then((agentPort) => {
        agentListenPort = agentPort
        cypressExecutable = require(`../../../versions/cypress@${version}`).get()
        return getPort().then(port => {
          appPort = port
          appServer.listen(appPort)
        })
      })
    })
    afterEach(() => {
      return Promise.all([
        agent.close(),
        new Promise(resolve => appServer.close(() => resolve()))
      ])
    })
    describe('cypress', function () {
      this.timeout(60000)
      it('instruments tests', function (done) {
        cypressExecutable.run({
          project: './packages/datadog-plugin-cypress/test/app',
          config: {
            baseUrl: `http://localhost:${appPort}`
          },
          env: {
            agent_port: agentListenPort
          },
          quiet: true
        })
        agent
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
          }).then(done).catch(done)
      })
    })
  })
})
