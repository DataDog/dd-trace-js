'use strict'

const { it } = require('mocha')
const { expect } = require('chai')
const agent = require('../../../../plugins/agent')
const { IntegrationTestHelper } = require('./base-integration-helper')

// Web server test helper for Express, Fastify, Koa, etc.
class WebServerTestHelper extends IntegrationTestHelper {
  constructor (pluginName, packageName, TestSetupClass, options = {}) {
    super(pluginName, packageName, TestSetupClass, {
      additionalPlugins: ['http'],
      ...options
    })
  }

  validateTestSetup (testSetup, pluginName) {
    const required = ['makeSuccessfulRequest', 'makeErrorRequest']
    const missing = required.filter(method => typeof testSetup[method] !== 'function')
    if (missing.length > 0) {
      throw new Error(`${pluginName} test setup missing: ${missing.join(', ')}`)
    }
  }

  generateTestCases (helper) {
    super.generateTestCases(helper)

    it('should instrument successful HTTP requests', (done) => {
      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', helper.pluginName)
          expect(traces[0][0].meta).to.have.property('http.method', 'GET')
          expect(traces[0][0].meta).to.have.property('http.status_code', '200')
          expect(traces[0][0].meta).to.have.property('span.kind', 'server')
        })
        .then(done)
        .catch(done)

      helper.testSetup.makeSuccessfulRequest().catch(done)
    })

    it('should instrument HTTP error responses', (done) => {
      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.have.property('error', 1)
          expect(traces[0][0].meta).to.have.property('http.status_code', '500')
        })
        .then(done)
        .catch(done)

      helper.testSetup.makeErrorRequest().then(() => {}).catch(done)
    })

    it('should instrument parameterized routes', (done) => {
      if (!helper.testSetup.makeParameterizedRequest) {
        done()
        return
      }

      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0].meta).to.have.property('http.route')
        })
        .then(done)
        .catch(done)

      helper.testSetup.makeParameterizedRequest().catch(done)
    })

    it('should instrument POST requests', (done) => {
      if (!helper.testSetup.makePostRequest) {
        done()
        return
      }

      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0].meta).to.have.property('http.method', 'POST')
        })
        .then(done)
        .catch(done)

      helper.testSetup.makePostRequest().catch(done)
    })
  }
}

module.exports = { WebServerTestHelper }
