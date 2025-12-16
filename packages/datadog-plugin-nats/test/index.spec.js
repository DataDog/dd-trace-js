'use strict'

// ⚠️ MUST be set BEFORE any requires that initialize the tracer!
process.env.DD_DATA_STREAMS_ENABLED = 'true'

const { expect } = require('chai')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/integration-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('nats', 'nats', testSetup, {
  category: 'messaging',
  pluginConfig: { dsmEnabled: true }
}, (meta) => {
  const { agent } = meta

  describe('NatsConnectionImpl.publish() - nats.publish', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'nats.publish',
          meta: {
            'span.kind': 'producer',
            'messaging.system': 'nats',
            'messaging.destination.name': 'test.hello',
            'messaging.operation': 'publish',
            component: 'nats'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.natsconnectionimpl_publish()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'nats.publish',
          meta: {
            'span.kind': 'producer',
            'error.type': Symbol.for('test.ANY_STRING'),
            'error.message': Symbol.for('test.ANY_STRING'),
            'error.stack': Symbol.for('test.ANY_STRING'),
            'messaging.system': 'nats',
            'messaging.destination.name': 'test.subject',
            'messaging.operation': 'publish',
            component: 'nats'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.natsconnectionimpl_publish_error()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('ProtocolHandler.processMsg() - nats.process', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        // Find the processMsg span (there may be publish spans too)
        let found = false
        for (const trace of traces) {
          for (const span of trace) {
            if (span.name === 'nats.processMsg') {
              expect(span.meta['span.kind']).to.equal('consumer')
              expect(span.meta['messaging.system']).to.equal('nats')
              expect(span.meta['messaging.destination.name']).to.equal('test.subscribe')
              expect(span.meta['messaging.operation']).to.equal('process')
              expect(span.meta.component).to.equal('nats')
              found = true
              return // Pass the assertion
            }
          }
        }
        if (!found) {
          throw new Error('Expected nats.processMsg span not found in traces')
        }
      })

      // Execute operation via test setup
      await testSetup.protocolhandler_processmsg()

      return traceAssertion
    })
  })

  describe('context propagation', () => {
    it('should link consumer span to producer span via distributed trace', async () => {
      const testSubject = 'test.context.propagation'
      let producerSpan = null
      let consumerSpan = null

      const traceAssertion = agent.assertSomeTraces((traces) => {
        const allSpans = traces.flat()

        // Find producer and consumer spans for our test subject
        for (const span of allSpans) {
          if (span.name === 'nats.publish' &&
              span.meta['messaging.destination.name'] === testSubject) {
            producerSpan = span
          }
          if (span.name === 'nats.processMsg' &&
              span.meta['messaging.destination.name'] === testSubject) {
            consumerSpan = span
          }
        }

        // Both spans must exist
        if (!producerSpan || !consumerSpan) {
          throw new Error(`Missing spans: producer=${!!producerSpan}, consumer=${!!consumerSpan}`)
        }

        // CRITICAL: Verify distributed trace - same trace ID
        expect(consumerSpan.trace_id.toString()).to.equal(producerSpan.trace_id.toString())

        // CRITICAL: Consumer is child of producer
        expect(consumerSpan.parent_id.toString()).to.equal(producerSpan.span_id.toString())
      })

      // Execute the context propagation test
      await testSetup.context_propagation_produce_consume()

      return traceAssertion
    })
  })

  describe('peer service', () => {
    const sinon = require('sinon')
    let computePeerServiceSpy

    beforeEach(() => {
      const tracerInstance = require('../../dd-trace')
      const plugin = tracerInstance._pluginManager._pluginsByName.nats
      computePeerServiceSpy = sinon.stub(plugin._tracerConfig, 'spanComputePeerService').value(true)
    })

    afterEach(() => {
      if (computePeerServiceSpy) {
        computePeerServiceSpy.restore()
      }
    })

    it('should set peer.service from nats.url on producer span', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'nats.publish',
        meta: {
          'span.kind': 'producer',
          'peer.service': '127.0.0.1:4222',
          '_dd.peer.service.source': 'nats.url'
        }
      })

      await testSetup.natsconnectionimpl_publish()

      return traceAssertion
    })
  })

  describe('DSM', () => {
    const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')
    const { ENTRY_PARENT_HASH } = require('../../dd-trace/src/datastreams/processor')
    const DataStreamsContext = require('../../dd-trace/src/datastreams/context')
    const sinon = require('sinon')
    let setDataStreamsContextSpy

    // Compute expected hashes for test subjects
    const getExpectedProducerHash = (subject) => {
      const edgeTags = ['direction:out', `topic:${subject}`, 'type:nats']
      edgeTags.sort()
      return computePathwayHash('test', 'tester', edgeTags, ENTRY_PARENT_HASH)
    }

    const getExpectedConsumerHash = (subject, parentHash) => {
      const edgeTags = ['direction:in', `topic:${subject}`, 'type:nats']
      edgeTags.sort()
      return computePathwayHash('test', 'tester', edgeTags, parentHash)
    }

    beforeEach(() => {
      setDataStreamsContextSpy = sinon.spy(DataStreamsContext, 'setDataStreamsContext')
    })

    afterEach(() => {
      setDataStreamsContextSpy.restore()
    })

    it('should set DSM checkpoint on produce', async () => {
      const testSubject = 'test.hello'
      const expectedHash = getExpectedProducerHash(testSubject)

      // Publish a message
      await testSetup.natsconnectionimpl_publish()

      // Verify setDataStreamsContext was called with the expected hash
      expect(setDataStreamsContextSpy.callCount).to.be.at.least(1)
      const producerCall = setDataStreamsContextSpy.getCalls().find(call => {
        const ctx = call.args[0]
        return ctx && ctx.hash && ctx.hash.equals(expectedHash)
      })
      expect(producerCall, 'Expected producer checkpoint with correct hash').to.exist
    })

    it('should set DSM checkpoint on consume', async () => {
      const testSubject = 'test.dsm'
      const expectedProducerHash = getExpectedProducerHash(testSubject)
      const expectedConsumerHash = getExpectedConsumerHash(testSubject, expectedProducerHash)

      // Use dedicated DSM test method that publishes with headers and consumes
      await testSetup.dsm_produce_consume()

      // Verify setDataStreamsContext was called
      const calls = setDataStreamsContextSpy.getCalls()
      expect(calls.length, 'Expected at least some DSM checkpoint calls').to.be.at.least(1)

      // Find calls that match expected hashes
      const producerCalls = calls.filter(call => {
        const ctx = call.args[0]
        return ctx && ctx.hash && ctx.hash.equals(expectedProducerHash)
      })
      const consumerCalls = calls.filter(call => {
        const ctx = call.args[0]
        return ctx && ctx.hash && ctx.hash.equals(expectedConsumerHash)
      })

      expect(producerCalls.length, 'Expected at least one producer checkpoint').to.be.at.least(1)
      expect(consumerCalls.length, 'Expected at least one consumer checkpoint').to.be.at.least(1)
    })
  })

  describe('ProtocolHandler.processMsg() - error handling', () => {
    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        // Find the processMsg span with error (there may be publish spans too)
        let found = false
        for (const trace of traces) {
          for (const span of trace) {
            if (span.name === 'nats.processMsg' && span.error === 1) {
              expect(span.meta['span.kind']).to.equal('consumer')
              expect(span.meta['messaging.system']).to.equal('nats')
              expect(span.meta['messaging.destination.name']).to.equal('test.error')
              expect(span.meta['messaging.operation']).to.equal('process')
              expect(span.meta.component).to.equal('nats')
              expect(span.meta['error.type']).to.be.a('string')
              expect(span.meta['error.message']).to.be.a('string')
              expect(span.meta['error.stack']).to.be.a('string')
              found = true
              return // Pass the assertion
            }
          }
        }
        if (!found) {
          throw new Error('Expected nats.processMsg error span not found in traces')
        }
      })

      // Execute operation error variant
      try {
        await testSetup.protocolhandler_processmsg_error()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })
})
