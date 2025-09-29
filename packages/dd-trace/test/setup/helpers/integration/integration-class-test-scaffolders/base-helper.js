'use strict'

const { expect } = require('chai')
const { it } = require('mocha')
const agent = require('../../../../plugins/agent')

class BaseTestHelper {
  constructor (config) {
    this.pluginName = config.pluginName
    this.packageName = config.packageName
    this.testSetup = config.testSetup
    this.getModule = config.getModule
    this.getTracer = config.getTracer
    this.testAgentClient = config.testAgentClient
    this.sessionToken = config.sessionToken
  }

  get mod () {
    return this.getModule()
  }

  get tracer () {
    return this.getTracer()
  }

  generateTestCases () {
    it('should load the module correctly', () => {
      expect(this.mod).to.be.an('object')
      expect(this.testSetup).to.be.an('object')
    })

    it('should create spans for instrumented operations', (done) => {
      if (!this.testSetup.performBasicOperation) {
        done()
        return
      }

      agent
        .assertSomeTraces(traces => {
          expect(traces).to.have.length.greaterThan(0)
          expect(traces[0]).to.have.length.greaterThan(0)
          expect(traces[0][0]).to.have.property('name')
          expect(traces[0][0]).to.have.property('service', 'test')
          expect(traces[0][0].meta).to.have.property('component')
        })
        .then(done)
        .catch(done)

      this.testSetup.performBasicOperation().catch(done)
    })
  }
}

module.exports = { BaseTestHelper }
