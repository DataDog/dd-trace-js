'use strict'

// ⚠️ MUST be at the TOP - before ANY requires!
process.env.DD_DATA_STREAMS_ENABLED = 'true'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

const { withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { expectedSchema } = require('./naming')
const DataStreamsContext = require('../../dd-trace/src/datastreams/context')
const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')
const { ENTRY_PARENT_HASH } = require('../../dd-trace/src/datastreams/processor')

function getDsmPathwayHash (subject, isProducer, parentHash) {
  const edgeTags = isProducer
    ? ['direction:out', `topic:${subject}`, 'type:nats']
    : ['direction:in', `topic:${subject}`, 'type:nats']

  return computePathwayHash('test', 'tester', edgeTags, parentHash)
}

describe('Plugin', () => {
  describe('@nats-io/nats-core', function () {
    this.timeout(10000)

    withVersions('nats-io-nats-core', '@nats-io/nats-core', (version) => {
      let nc
      let tracer

      describe('without configuration', () => {
        beforeEach(async () => {
          tracer = require('../../dd-trace')
          await agent.load('@nats-io/nats-core')

          // Require transport-node directly from versions node_modules
          const { connect } = require('../../dd-trace/test/plugins/versions/node_modules/@nats-io/transport-node')
          nc = await connect({
            servers: '127.0.0.1:4222',
            timeout: 5000
          })
        })

        afterEach(async () => {
          if (nc) {
            await nc.drain()
            await nc.close()
          }
        })

        after(async () => {
          await agent.close({ ritmReset: false })
        })

        describe('producer (publish)', () => {
          it('should be instrumented', (done) => {
            agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', expectedSchema.send.opName)
                expect(span).to.have.property('service', expectedSchema.send.serviceName)
                expect(span).to.have.property('resource', 'publish')
                expect(span).to.have.property('error', 0)
                expect(span.meta).to.include({
                  component: '@nats-io/nats-core',
                  'span.kind': 'producer'
                })
              })
              .then(done)
              .catch(done)

            nc.publish('test.subject', 'Hello NATS')
          })

          it('should handle errors', (done) => {
            let error

            agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('error', 1)
                expect(span.meta).to.include({
                  [ERROR_TYPE]: error.name,
                  [ERROR_MESSAGE]: error.message,
                  component: '@nats-io/nats-core'
                })
                expect(span.meta).to.have.property(ERROR_STACK)
              })
              .then(done)
              .catch(done)

            try {
              nc.publish('', 'Invalid subject')
            } catch (err) {
              error = err
            }
          })
        })

        describe('consumer (processMsg)', () => {
          it('should be instrumented', (done) => {
            let messageReceived = false

            agent
              .assertSomeTraces(traces => {
                const consumerSpan = traces.find(t => t[0].meta['span.kind'] === 'consumer')?.[0]
                if (!consumerSpan) return false

                expect(consumerSpan).to.have.property('name', expectedSchema.receive.opName)
                expect(consumerSpan).to.have.property('service', expectedSchema.receive.serviceName)
                expect(consumerSpan).to.have.property('resource', 'processMsg')
                expect(consumerSpan).to.have.property('error', 0)
                expect(consumerSpan.meta).to.include({
                  component: '@nats-io/nats-core',
                  'span.kind': 'consumer'
                })
                return messageReceived
              })
              .then(done)
              .catch(done)

            const sub = nc.subscribe('test.consumer', {
              callback: (err, msg) => {
                if (!err) {
                  messageReceived = true
                }
              }
            })

            setTimeout(() => {
              nc.publish('test.consumer', 'Test message')
            }, 100)
          })
        })

        describe('client (request)', () => {
          it('should be instrumented', (done) => {
            agent
              .assertSomeTraces(traces => {
                const requestSpan = traces.find(t => t[0].meta['span.kind'] === 'client')?.[0]
                if (!requestSpan) return false

                expect(requestSpan).to.have.property('name', expectedSchema.request.opName)
                expect(requestSpan).to.have.property('service', expectedSchema.request.serviceName)
                expect(requestSpan).to.have.property('resource', 'request')
                expect(requestSpan).to.have.property('error', 0)
                expect(requestSpan.meta).to.include({
                  component: '@nats-io/nats-core',
                  'span.kind': 'client'
                })
                return true
              })
              .then(done)
              .catch(done)

            // Set up a simple responder
            nc.subscribe('test.request', {
              callback: (err, msg) => {
                if (!err && msg.reply) {
                  nc.publish(msg.reply, 'Response')
                }
              }
            })

            setTimeout(async () => {
              try {
                await nc.request('test.request', 'Request data', { timeout: 1000 })
              } catch (err) {
                // Timeout is okay for this test
              }
            }, 100)
          })
        })

        describe('context propagation', () => {
          const testSubject = 'test.context.propagation'

          it('should inject trace context into producer messages', (done) => {
            agent
              .assertSomeTraces(traces => {
                const producerSpan = traces.flat().find(span =>
                  span.meta['span.kind'] === 'producer' &&
                  span.meta['messaging.destination.name'] === testSubject
                )

                if (!producerSpan) return false

                expect(producerSpan).to.exist
                expect(producerSpan.trace_id).to.exist
                expect(producerSpan.span_id).to.exist
              })
              .then(done)
              .catch(done)

            // Send message - tracer should inject context into headers
            nc.publish(testSubject, 'Context propagation test')
          })

          it('should link consumer span to producer span via distributed trace', (done) => {
            let producerSpan
            let consumerSpan
            let messageReceived = false

            agent
              .assertSomeTraces(traces => {
                const allSpans = traces.flat()

                for (const span of allSpans) {
                  if (span.meta['span.kind'] === 'producer' && span.meta['messaging.destination.name'] === testSubject) {
                    producerSpan = span
                  }
                  if (span.meta['span.kind'] === 'consumer' && span.meta['messaging.destination.name'] === testSubject) {
                    consumerSpan = span
                  }
                }

                if (!producerSpan || !consumerSpan || !messageReceived) return false

                // CRITICAL: Verify distributed trace - same trace ID
                expect(consumerSpan.trace_id.toString())
                  .to.equal(producerSpan.trace_id.toString())

                // CRITICAL: Consumer is child of producer
                expect(consumerSpan.parent_id.toString())
                  .to.equal(producerSpan.span_id.toString())

                return true
              })
              .then(done)
              .catch(done)

            // Set up consumer first
            nc.subscribe(testSubject, {
              callback: (err, msg) => {
                if (!err) {
                  messageReceived = true
                }
              }
            })

            // Then send message - creates distributed trace
            setTimeout(() => {
              nc.publish(testSubject, 'Distributed trace test')
            }, 100)
          })
        })
      })

      describe('peer service', () => {
        const testSubject = 'test.peer.service.subject'

        beforeEach(async () => {
          tracer = require('../../dd-trace')
          await agent.load('@nats-io/nats-core', {}, { spanComputePeerService: true })

          // Require transport-node directly from versions node_modules
          const { connect } = require('../../dd-trace/test/plugins/versions/node_modules/@nats-io/transport-node')
          nc = await connect({
            servers: '127.0.0.1:4222',
            timeout: 5000
          })
        })

        afterEach(async () => {
          if (nc) {
            await nc.drain()
            await nc.close()
          }
        })

        after(async () => {
          await agent.close({ ritmReset: false })
        })

        it('should set peer.service from messaging.destination.name for producer', (done) => {
          agent
            .assertSomeTraces(traces => {
              const span = traces[0][0]
              if (span.meta['span.kind'] !== 'producer') return false

              expect(span.meta['peer.service']).to.equal(testSubject)
              expect(span.meta['_dd.peer.service.source']).to.equal('messaging.destination.name')
              return true
            })
            .then(() => done())
            .catch(done)

          nc.publish(testSubject, 'Peer service test')
        })

        it('should set peer.service from messaging.destination.name for consumer', (done) => {
          let messageReceived = false

          agent
            .assertSomeTraces(traces => {
              const consumerSpan = traces.find(t => t[0].meta['span.kind'] === 'consumer')?.[0]
              if (!consumerSpan) return false

              expect(consumerSpan.meta['peer.service']).to.equal(testSubject)
              expect(consumerSpan.meta['_dd.peer.service.source']).to.equal('messaging.destination.name')
              return messageReceived
            })
            .then(done)
            .catch(done)

          const sub = nc.subscribe(testSubject, {
            callback: (err, msg) => {
              if (!err) {
                messageReceived = true
              }
            }
          })

          setTimeout(() => {
            nc.publish(testSubject, 'Peer service consumer test')
          }, 100)
        })

        it('should set peer.service from messaging.destination.name for client', (done) => {
          agent
            .assertSomeTraces(traces => {
              const requestSpan = traces.find(t => t[0].meta['span.kind'] === 'client')?.[0]
              if (!requestSpan) return false

              expect(requestSpan.meta['peer.service']).to.equal(testSubject)
              expect(requestSpan.meta['_dd.peer.service.source']).to.equal('messaging.destination.name')
              return true
            })
            .then(done)
            .catch(done)

          // Set up a simple responder
          nc.subscribe(testSubject, {
            callback: (err, msg) => {
              if (!err && msg.reply) {
                nc.publish(msg.reply, 'Response')
              }
            }
          })

          setTimeout(async () => {
            try {
              await nc.request(testSubject, 'Request data', { timeout: 1000 })
            } catch (err) {
              // Timeout is okay for this test
            }
          }, 100)
        })
      })

      describe('DSM', () => {
        let setDataStreamsContextSpy
        const testSubject = 'test.dsm.subject'

        beforeEach(async () => {
          tracer = require('../../dd-trace')
          await agent.load('@nats-io/nats-core', { dsmEnabled: true })

          // Require transport-node directly from versions node_modules
          const { connect } = require('../../dd-trace/test/plugins/versions/node_modules/@nats-io/transport-node')
          nc = await connect({
            servers: '127.0.0.1:4222',
            timeout: 5000
          })

          setDataStreamsContextSpy = sinon.spy(DataStreamsContext, 'setDataStreamsContext')
        })

        afterEach(async () => {
          setDataStreamsContextSpy.restore()

          if (nc) {
            await nc.drain()
            await nc.close()
          }
        })

        after(async () => {
          await agent.close({ ritmReset: false })
        })

        it('should set DSM checkpoint on produce', (done) => {
          const expectedProducerHash = getDsmPathwayHash(testSubject, true, ENTRY_PARENT_HASH)

          agent
            .assertSomeTraces(traces => {
              const span = traces[0][0]
              if (span.meta['span.kind'] !== 'producer') return false

              // Verify setDataStreamsContext was called with correct hash
              expect(setDataStreamsContextSpy.called).to.be.true
              expect(setDataStreamsContextSpy.args[0][0].hash).to.equal(expectedProducerHash)
              return true
            })
            .then(done)
            .catch(done)

          nc.publish(testSubject, 'DSM test message')
        })

        it('should set DSM checkpoint on consume', (done) => {
          const expectedProducerHash = getDsmPathwayHash(testSubject, true, ENTRY_PARENT_HASH)
          const expectedConsumerHash = getDsmPathwayHash(testSubject, false, expectedProducerHash)
          let messageReceived = false

          agent
            .assertSomeTraces(traces => {
              const consumerSpan = traces.find(t => t[0].meta['span.kind'] === 'consumer')?.[0]
              if (!consumerSpan) return false

              // Verify consumer checkpoint was set with correct hash
              expect(setDataStreamsContextSpy.lastCall.args[0].hash).to.equal(expectedConsumerHash)
              return messageReceived
            })
            .then(done)
            .catch(done)

          const sub = nc.subscribe(testSubject, {
            callback: (err, msg) => {
              if (!err) {
                messageReceived = true
              }
            }
          })

          setTimeout(() => {
            nc.publish(testSubject, 'DSM test message')
          }, 100)
        })
      })
    })
  })
})
