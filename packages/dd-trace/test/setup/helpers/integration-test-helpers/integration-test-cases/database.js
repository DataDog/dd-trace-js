'use strict'

const { it } = require('mocha')
const { expect } = require('chai')
const { BaseTestHelper } = require('./base')

class DatabaseTestHelper extends BaseTestHelper {
  generateTestCases () {
    // beforeEach(() => {
    //     if (this.testSetup.setup) {
    //         this.testSetup.setup()
    //     }
    // })

    super.generateTestCases()

    it('should instrument database queries', function (done) {
      this.agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', this.pluginName)
          expect(traces[0][0].meta).to.have.property('span.kind', 'client')
          expect(traces[0][0].meta).to.have.property('db.system')
          expect(traces[0][0].meta).to.have.property('db.statement')
        })
        .then(done)
        .catch(done)

      this.testSetup.query({ query: 'SELECT 1' }).catch(done)
    })

    it('should instrument database reads', function (done) {
      this.agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', this.pluginName)
          expect(traces[0][0].meta).to.have.property('span.kind', 'client')
          expect(traces[0][0].meta).to.have.property('db.system')
        })
        .then(done)
        .catch(done)

      this.testSetup.read({ key: 'test-key' }).catch(done)
    })

    it('should instrument database writes', function (done) {
      this.agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', this.pluginName)
          expect(traces[0][0].meta).to.have.property('span.kind', 'client')
          expect(traces[0][0].meta).to.have.property('db.system')
        })
        .then(done)
        .catch(done)

      this.testSetup.write({ key: 'test-key', value: 'test-value' }).catch(done)
    })

    it('should handle query errors', function (done) {
      this.agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.have.property('error', 1)
          expect(traces[0][0].meta).to.have.property('component', this.pluginName)
        })
        .then(done)
        .catch(done)

      this.testSetup.query({ query: 'SELECT 1', expectError: true }).catch(() => {})
    })

    it('should handle read errors', function (done) {
      this.agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.have.property('error', 1)
          expect(traces[0][0].meta).to.have.property('component', this.pluginName)
        })
        .then(done)
        .catch(done)

      this.testSetup.read({ key: 'test-key', expectError: true }).catch(() => {})
    })

    it('should handle write errors', function (done) {
      this.agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.have.property('error', 1)
          expect(traces[0][0].meta).to.have.property('component', this.pluginName)
        })
        .then(done)
        .catch(done)

      this.testSetup.write({ key: 'test-key', value: 'test-value', expectError: true }).catch(() => {})
    })
  }
}

module.exports = { DatabaseTestHelper }
