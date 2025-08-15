'use strict'

const { expect } = require('chai')
const assert = require('node:assert')
const getPort = require('get-port')
const os = require('node:os')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { expectedSchema, rawExpectedSchema } = require('./naming')
const { assertObjectContains } = require('../../../integration-tests/helpers')

const sort = trace => trace.sort((a, b) => Number(a.start - b.start))

describe('Plugin', () => {
  let broker
  let port

  describe('moleculer', () => {
    withVersions('moleculer', 'moleculer', version => {
      const startBroker = async () => {
        const { ServiceBroker } = require(`../../../versions/moleculer@${version}`).get()

        port = await getPort()

        broker = new ServiceBroker({
          namespace: 'multi',
          nodeID: `server-${process.pid}`,
          logger: false,
          transporter: `tcp://127.0.0.1:${port}/server-${process.pid}`
        })

        broker.createService({
          name: 'math',
          actions: {
            async add (ctx) {
              const numerify = this.actions.numerify

              return await numerify(ctx.params.a) + await numerify(ctx.params.b)
            },

            numerify (ctx) {
              return Number(ctx.params)
            }
          }
        })

        broker.createService({
          name: 'error',
          actions: {
            async error (ctx) {
              throw new Error('Invalid number')
            }
          }
        })

        return broker.start()
      }

      describe('server', () => {
        describe('without configuration', () => {
          before(() => agent.load('moleculer', { client: false }))

          before(() => startBroker())

          after(() => broker.stop())

          after(() => agent.close({ ritmReset: false }))

          it('should do automatic instrumentation', done => {
            agent.assertSomeTraces(traces => {
              const spans = sort(traces[0])

              expect(spans[0]).to.have.property('name', expectedSchema.server.opName)
              expect(spans[0]).to.have.property('service', expectedSchema.server.serviceName)
              expect(spans[0]).to.have.property('type', 'web')
              expect(spans[0]).to.have.property('resource', 'math.add')
              expect(spans[0].meta).to.have.property('span.kind', 'server')
              expect(spans[0].meta).to.have.property('moleculer.context.action', 'math.add')
              expect(spans[0].meta).to.have.property('moleculer.context.node_id', `server-${process.pid}`)
              expect(spans[0].meta).to.have.property('moleculer.context.request_id')
              expect(spans[0].meta).to.have.property('moleculer.context.service', 'math')
              expect(spans[0].meta).to.have.property('moleculer.namespace', 'multi')
              expect(spans[0].meta).to.have.property('moleculer.node_id', `server-${process.pid}`)
              expect(spans[0].meta).to.have.property('component', 'moleculer')
              expect(spans[0].meta).to.have.property('_dd.integration', 'moleculer')

              expect(spans[1]).to.have.property('name', expectedSchema.server.opName)
              expect(spans[1]).to.have.property('service', expectedSchema.server.serviceName)
              expect(spans[1]).to.have.property('type', 'web')
              expect(spans[1]).to.have.property('resource', 'math.numerify')
              expect(spans[1].meta).to.have.property('span.kind', 'server')
              expect(spans[1].meta).to.have.property('moleculer.context.action', 'math.numerify')
              expect(spans[1].meta).to.have.property('moleculer.context.node_id', `server-${process.pid}`)
              expect(spans[1].meta).to.have.property('moleculer.context.request_id')
              expect(spans[1].meta).to.have.property('moleculer.context.service', 'math')
              expect(spans[1].meta).to.have.property('moleculer.namespace', 'multi')
              expect(spans[1].meta).to.have.property('moleculer.node_id', `server-${process.pid}`)
              expect(spans[1].meta).to.have.property('component', 'moleculer')
            }).then(done, done)

            broker.call('math.add', { a: 5, b: 3 }).catch(done)
          })
          withNamingSchema(
            (done) => broker.call('math.add', { a: 5, b: 3 }).catch(done),
            rawExpectedSchema.server
          )
        })

        describe('with configuration', () => {
          before(() => agent.load('moleculer', {
            client: false,
            server: { service: 'custom' },
            params: true,
            meta: true
          }))

          before(() => startBroker())

          after(() => broker.stop())

          after(() => agent.close({ ritmReset: false }))

          it('should have the configured service name', done => {
            agent.assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('service', 'custom')
            }).then(done, done)

            broker.call('math.add', { a: 5, b: 3 }).catch(done)
          })

          withNamingSchema(
            (done) => broker.call('math.add', { a: 5, b: 3 }).catch(done),
            {
              v0: {
                opName: 'moleculer.action',
                serviceName: 'custom'
              },
              v1: {
                opName: 'moleculer.server.request',
                serviceName: 'custom'
              }
            }
          )
        })
      })

      describe('client', () => {
        describe('without configuration', () => {
          const hostname = os.hostname()
          let tracer

          beforeEach(() => startBroker())

          afterEach(() => broker.stop())

          beforeEach(done => {
            agent.load('moleculer', { server: false })
              .then(() => { tracer = require('../../dd-trace') })
              .then(done)
              .catch(done)
          })

          afterEach(() => agent.close({ ritmReset: false }))

          withPeerService(
            () => tracer,
            'moleculer',
            () => broker.call('math.add', { a: 5, b: 3 }),
            hostname,
            'out.host'
          )

          it('should do automatic instrumentation', async () => {
            const result = await broker.call('math.add', { a: 5, b: 3 })
            assert.strictEqual(result, 8)

            agent.assertSomeTraces(traces => {
              const span = traces[0][0]

              assertObjectContains(span, {
                name: expectedSchema.client.opName,
                service: expectedSchema.client.serviceName,
                resource: 'math.add',
                meta: {
                  'span.kind': 'client',
                  'out.host': hostname,
                  'moleculer.context.action': 'math.add',
                  'moleculer.context.node_id': `server-${process.pid}`,
                  'moleculer.context.service': 'math',
                  'moleculer.namespace': 'multi',
                  'moleculer.node_id': `server-${process.pid}`,
                },
                metrics: {
                  'network.destination.port': port
                }
              })

              assert.strictEqual(typeof span.meta['moleculer.context.request_id'], 'string')
            })
          })

          it('should handle error cases', async () => {
            await assert.rejects(broker.call('error.error'), { message: 'Invalid number' })

            agent.assertSomeTraces(traces => {
              const span = traces[0][0]

              assertObjectContains(span, {
                name: expectedSchema.client.opName,
                service: expectedSchema.client.serviceName,
                resource: 'error.error',
                meta: {
                  'span.kind': 'client',
                  'out.host': hostname,
                  'moleculer.context.action': 'error.error',
                  'moleculer.context.node_id': `server-${process.pid}`,
                  'moleculer.context.service': 'error',
                  'moleculer.namespace': 'multi',
                  'moleculer.node_id': `server-${process.pid}`,
                },
                metrics: {
                  'network.destination.port': port
                }
              })

              assert.strictEqual(typeof span.meta['moleculer.context.request_id'], 'string')
            })
          })

          withNamingSchema(
            (done) => broker.call('math.add', { a: 5, b: 3 }).catch(done),
            rawExpectedSchema.client
          )
        })

        describe('with configuration', () => {
          before(() => agent.load('moleculer', {
            client: { service: 'custom' },
            server: false,
            params: true,
            meta: true
          }))

          before(() => startBroker())

          after(() => broker.stop())

          after(() => agent.close({ ritmReset: false }))

          it('should have the configured service name', done => {
            agent.assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('service', 'custom')
            }).then(done, done)

            broker.call('math.add', { a: 5, b: 3 }).catch(done)
          })

          withNamingSchema(
            (done) => broker.call('math.add', { a: 5, b: 3 }).catch(done),
            {
              v0: {
                opName: 'moleculer.call',
                serviceName: 'custom'
              },
              v1: {
                opName: 'moleculer.client.request',
                serviceName: 'custom'
              }
            }
          )
        })
      })

      describe('client + server (local)', () => {
        before(() => agent.load('moleculer'))

        before(() => startBroker())

        after(() => broker.stop())

        after(() => agent.close({ ritmReset: false }))

        it('should propagate context', async () => {
          let spanId
          let parentId

          const clientPromise = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            expect(spans[0]).to.have.property('name', expectedSchema.client.opName)

            spanId = spans[0].span_id
          })

          const serverPromise = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            expect(spans[0]).to.have.property('name', expectedSchema.server.opName)
            expect(spans[1]).to.have.property('name', expectedSchema.server.opName)

            parentId = spans[0].parent_id
          })

          await broker.call('math.add', { a: 5, b: 3 })

          // We end up with 2 traces because context propagation uses
          // inject/extract for both local and remote.
          await Promise.all([clientPromise, serverPromise])

          expect(spanId.toString()).to.equal(parentId.toString())
        })
      })

      describe('client + server (remote)', () => {
        let clientBroker

        before(() => agent.load('moleculer'))

        before(() => startBroker())

        before(function () {
          const waitTimeout = 10000
          this.timeout(waitTimeout) // wait for discovery
          const { ServiceBroker } = require(`../../../versions/moleculer@${version}`).get()

          clientBroker = new ServiceBroker({
            namespace: 'multi',
            nodeID: `client-${process.pid}`,
            logger: false,
            transporter: {
              type: 'TCP',
              options: {
                udpDiscovery: false,
                urls: [
                  `127.0.0.1:${port}/server-${process.pid}`
                ]
              }
            }
          })

          return clientBroker.start()
            .then(() => clientBroker.waitForServices('math', waitTimeout))
        })

        after(() => clientBroker.stop())

        after(() => broker.stop())

        after(() => agent.close({ ritmReset: false }))

        it('should propagate context', async () => {
          let spanId
          let parentId

          const clientPromise = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            expect(spans[0]).to.have.property('name', expectedSchema.client.opName)
            expect(spans[0].meta).to.have.property('moleculer.context.node_id', `server-${process.pid}`)
            expect(spans[0].meta).to.have.property('moleculer.node_id', `client-${process.pid}`)

            spanId = spans[0].span_id
          })

          const serverPromise = agent.assertSomeTraces(traces => {
            const spans = sort(traces[0])

            expect(spans[0]).to.have.property('name', expectedSchema.server.opName)
            expect(spans[1]).to.have.property('name', expectedSchema.server.opName)

            parentId = spans[0].parent_id
          })

          await clientBroker.call('math.add', { a: 5, b: 3 })

          await Promise.all([clientPromise, serverPromise])

          expect(spanId.toString()).to.equal(parentId.toString())
        })
      })
      describe('meta propagation', () => {
        before(() => agent.load('moleculer', {
          meta: true
        }))

        before(async () => {
          const { ServiceBroker } = require(`../../../versions/moleculer@${version}`).get()
          broker = new ServiceBroker({
            nodeID: `server-${process.pid}`,
            logger: false
          })

          broker.createService({
            name: 'test',
            actions: {
              async first (ctx) {
                await ctx.call('test.second', null, {
                  meta: {
                    a: 'John'
                  }
                })
                return ctx.meta.a
              },
              second (ctx) {
                ctx.meta.a = 'Doe'
              }
            }
          })

          return broker.start()
        })

        after(() => broker.stop())

        after(() => agent.close({ ritmReset: false }))

        it('should propagate meta from child to parent', async () => {
          const result = await broker.call('test.first')
          assert.strictEqual(result, 'Doe')
        })
      })
    })
  })
})
