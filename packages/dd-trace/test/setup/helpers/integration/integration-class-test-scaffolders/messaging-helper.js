'use strict'

const { it } = require('mocha')
const { expect } = require('chai')
const agent = require('../../../../plugins/agent')
const { BaseTestHelper } = require('./base-helper')

class MessagingTestHelper extends BaseTestHelper {
  static get operations () {
    return {
      required: [
        'addJob',
        'addJobError',
        'waitForJobCompletion'
      ],
      optional: [
        'addBulkJobs',
        'addBulkJobsError',
        'addDelayedJob',
        'addDelayedJobError',
        'addJobWithPriority',
        'addJobWithPriorityError'
      ]
    }
  }

  validateTestSetup (testSetup, pluginName) {
    const required = ['addJob', 'waitForJobCompletion']
    const missing = required.filter(method => typeof testSetup[method] !== 'function')
    if (missing.length > 0) {
      throw new Error(`${pluginName} test setup missing: ${missing.join(', ')}`)
    }
  }

  generateTestCases () {
    super.generateTestCases()
    const testSetup = this.testSetup
    const testClass = this

    it('should instrument message production', function (done) {
      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', testClass.pluginName)
          expect(traces[0][0].meta).to.have.property('span.kind', 'producer')
          expect(traces[0][0].meta).to.have.property('messaging.operation', 'produce')
          expect(traces[0][0].meta).to.have.property('messaging.destination.name', testSetup.queueName)
          expect(traces[0][0].meta).to.have.property('messaging.system', testClass.pluginName)
        })
        .then(done)
        .catch(done)

      process.nextTick(() => testSetup.addJob().catch(done))
    })

    it('should instrument message consumption', function (done) {
      agent
        .assertSomeTraces(traces => {
          expect(traces).to.have.length.greaterThan(0)
          const spans = traces.flat()
          const consumerSpan = spans.find(span => span.meta && span.meta['span.kind'] === 'consumer')
          expect(consumerSpan).to.exist
          expect(consumerSpan.meta).to.have.property('component', testClass.pluginName)
          expect(traces[0][0].meta).to.have.property('messaging.operation', 'consume')
          expect(traces[0][0].meta).to.have.property('messaging.destination.name', testClass.queueName)
          expect(traces[0][0].meta).to.have.property('messaging.system', testClass.integrationName)
        })
        .then(done)
        .catch(done)

      testSetup.addJob()
        .then(job => testSetup.waitForJobCompletion(job))
        .catch(done)
    })

    it('should instrument job processing errors', function (done) {
      if (!testSetup.addErrorJob) {
        this.skip()
        return
      }

      agent
        .assertSomeTraces(traces => {
          const spans = traces.flat()
          const errorSpan = spans.find(span => span.error === 1)
          expect(errorSpan).to.exist
          expect(errorSpan.meta).to.have.property('component', testClass.pluginName)
        })
        .then(done)
        .catch(done)

      testSetup.addErrorJob().catch(done)
    })

    it('should instrument bulk job operations', function (done) {
      if (!testSetup.addBulkJobs) {
        this.skip()
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

      testSetup.addBulkJobs(3).catch(done)
    })

    it('should instrument delayed jobs', function (done) {
      if (!testSetup.addDelayedJob) {
        this.skip()
        return
      }

      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', testClass.pluginName)
          expect(traces[0][0].meta).to.have.property('span.kind', 'producer')
        })
        .then(done)
        .catch(done)

      testSetup.addDelayedJob().catch(done)
    })

    it('should instrument priority jobs', function (done) {
      if (!testSetup.addJobWithPriority) {
        this.skip()
        return
      }

      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', testClass.pluginName)
          expect(traces[0][0].meta).to.have.property('span.kind', 'producer')
        })
        .then(done)
        .catch(done)

      testSetup.addJobWithPriority().catch(done)
    })

    it('should handle errors in message production', function (done) {
      if (!testSetup.addJobError) {
        this.skip()
        return
      }

      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.have.property('error', 1)
          expect(traces[0][0].meta).to.have.property('component', testClass.pluginName)
        })
        .then(done)
        .catch(done)

      testSetup.addJobError().catch(() => {})
    })

    it('should handle bulk job errors', function (done) {
      if (!testSetup.addBulkJobsError) {
        this.skip()
        return
      }

      agent.assertSomeTraces(traces => {
        const errorSpan = traces.flat().find(span => span.error === 1)
        expect(errorSpan).to.exist
      }).then(done).catch(done)
      testSetup.addBulkJobsError().catch(() => {})
    })

    it('should handle delayed job errors', function (done) {
      if (!testSetup.addDelayedJobError) {
        this.skip()
        return
      }

      agent.assertSomeTraces(traces => {
        expect(traces[0][0]).to.have.property('error', 1)
      }).then(done).catch(done)
      testSetup.addDelayedJobError().catch(() => {})
    })

    it('should handle priority job errors', function (done) {
      if (!testSetup.addJobWithPriorityError) {
        this.skip()
        return
      }

      agent.assertSomeTraces(traces => {
        expect(traces[0][0]).to.have.property('error', 1)
      }).then(done).catch(done)
      testSetup.addJobWithPriorityError().catch(() => {})
    })
  }
}

module.exports = { MessagingTestHelper }
