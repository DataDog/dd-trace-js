'use strict'

const { it } = require('mocha')
const { expect } = require('chai')
const agent = require('../../../../plugins/agent')
const { IntegrationTestHelper } = require('./base-integration-helper')

// Messaging test helper for BullMQ, Kafka, RabbitMQ, etc.
class MessagingTestHelper extends IntegrationTestHelper {
  validateTestSetup (testSetup, pluginName) {
    const required = ['addJob', 'waitForJobCompletion']
    const missing = required.filter(method => typeof testSetup[method] !== 'function')
    if (missing.length > 0) {
      throw new Error(`${pluginName} test setup missing: ${missing.join(', ')}`)
    }
  }

  generateTestCases (helper) {
    super.generateTestCases(helper)

    it('should instrument message production', (done) => {
      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', helper.pluginName)
          expect(traces[0][0].meta).to.have.property('span.kind', 'producer')
        })
        .then(done)
        .catch(done)

      helper.testSetup.addJob().catch(done)
    })

    it('should instrument message consumption', (done) => {
      agent
        .assertSomeTraces(traces => {
          expect(traces).to.have.length.greaterThan(0)
          const spans = traces.flat()
          const consumerSpan = spans.find(span => span.meta && span.meta['span.kind'] === 'consumer')
          expect(consumerSpan).to.exist
          expect(consumerSpan.meta).to.have.property('component', helper.pluginName)
        })
        .then(done)
        .catch(done)

      helper.testSetup.addJob()
        .then(job => helper.testSetup.waitForJobCompletion(job))
        .catch(done)
    })

    it('should instrument job processing errors', (done) => {
      if (!helper.testSetup.addErrorJob) {
        done()
        return
      }

      agent
        .assertSomeTraces(traces => {
          const spans = traces.flat()
          const errorSpan = spans.find(span => span.error === 1)
          expect(errorSpan).to.exist
          expect(errorSpan.meta).to.have.property('component', helper.pluginName)
        })
        .then(done)
        .catch(done)

      helper.testSetup.addErrorJob().catch(done)
    })

    it('should instrument bulk job operations', (done) => {
      if (!helper.testSetup.addBulkJobs) {
        done()
        return
      }

      agent
        .assertSomeTraces(traces => {
          const spans = traces.flat()
          const producerSpans = spans.filter(span => span.meta && span.meta['span.kind'] === 'producer')
          expect(producerSpans).to.have.length.greaterThan(1)
        })
        .then(done)
        .catch(done)

      helper.testSetup.addBulkJobs(3).catch(done)
    })

    it('should instrument delayed jobs', (done) => {
      if (!helper.testSetup.addDelayedJob) {
        done()
        return
      }

      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', helper.pluginName)
          expect(traces[0][0].meta).to.have.property('span.kind', 'producer')
        })
        .then(done)
        .catch(done)

      helper.testSetup.addDelayedJob().catch(done)
    })

    it('should instrument priority jobs', (done) => {
      if (!helper.testSetup.addJobWithPriority) {
        done()
        return
      }

      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', helper.pluginName)
          expect(traces[0][0].meta).to.have.property('span.kind', 'producer')
        })
        .then(done)
        .catch(done)

      helper.testSetup.addJobWithPriority().catch(done)
    })
  }
}

module.exports = { MessagingTestHelper }
