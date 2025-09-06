'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const semver = require('semver')

const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { expectedSchema, rawExpectedSchema } = require('./naming')

const MongodbCorePlugin = require('../../datadog-plugin-mongodb-core/src/index')
const ddpv = require('mocha/package.json').version

const withTopologies = fn => {
  withVersions('mongodb-core', 'mongodb', '>=2', (version, moduleName) => {
    describe('using the default topology', () => {
      fn(async () => {
        const { MongoClient } = require(`../../../versions/${moduleName}@${version}`).get()
        const client = new MongoClient('mongodb://127.0.0.1:27017')

        await client.connect()

        return client
      })
    })

    // unified topology is now the only topology and thus the default since 4.x
    if (!semver.intersects(version, '>=4')) {
      describe('using the unified topology', () => {
        fn(async () => {
          const { MongoClient, Server } = require(`../../../versions/${moduleName}@${version}`).get()
          const server = new Server('127.0.0.1', 27017, { reconnect: false })
          const client = new MongoClient(server, { useUnifiedTopology: true })

          await client.connect()

          return client
        })
      })
    }
  })
}

describe('Plugin', () => {
  let client
  let id
  let tracer
  let collectionName
  let collection
  let db
  let BSON
  let startSpy

  describe('mongodb-core', () => {
    withTopologies(createClient => {
      beforeEach(() => {
        id = require('../../dd-trace/src/id')
        tracer = require('../../dd-trace')

        collectionName = id().toString()

        BSON = require('../../../versions/bson@4.0.0').get()
      })

      afterEach(() => {
        return client.close()
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load('mongodb-core')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(async () => {
          client = await createClient()
          db = client.db('test')
          collection = db.collection(collectionName)
        })

        describe('server', () => {
          withPeerService(
            () => tracer,
            'mongodb-core',
            (done) => collection.insertOne({ a: 1 }, {}, done),
            'test',
            'peer.service'
          )

          it('should do automatic instrumentation', done => {
            agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                const resource = `insert test.${collectionName}`

                expect(span).to.have.property('name', expectedSchema.outbound.opName)
                expect(span).to.have.property('service', expectedSchema.outbound.serviceName)
                expect(span).to.have.property('resource', resource)
                expect(span).to.have.property('type', 'mongodb')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('db.name', `test.${collectionName}`)
                expect(span.meta).to.have.property('out.host', '127.0.0.1')
                expect(span.meta).to.have.property('component', 'mongodb')
              })
              .then(done)
              .catch(done)

            collection.insertOne({ a: 1 }, {}, () => {})
          })

          it('should use the correct resource name for arbitrary commands', done => {
            agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                const resource = 'planCacheListPlans test.$cmd'
                const query = '{}'

                expect(span).to.have.property('resource', resource)
                expect(span.meta).to.have.property('mongodb.query', query)
              })
              .then(done)
              .catch(done)

            db.command({
              planCacheListPlans: `test.${collectionName}`,
              query: {}
            }, () => {})
          })

          it('should sanitize buffers as values and not as objects', done => {
            agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                const resource = `find test.${collectionName}`
                const query = '{"_id":"?"}'

                expect(span).to.have.property('resource', resource)
                expect(span.meta).to.have.property('mongodb.query', query)
              })
              .then(done)
              .catch(done)

            collection.find({
              _id: Buffer.from('1234')
            }).toArray()
          })

          it('should sanitize BSON binary', done => {
            agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                const resource = `find test.${collectionName}`
                const query = '{"_bin":"?"}'

                expect(span).to.have.property('resource', resource)
                expect(span.meta).to.have.property('mongodb.query', query)
              })
              .then(done)
              .catch(done)

            collection.find({
              _bin: new BSON.Binary()
            }).toArray()
          })

          it('should stringify BSON primitives', done => {
            const id = '123456781234567812345678'

            agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                const resource = `find test.${collectionName}`
                const query = `{"_id":"${id}"}`

                expect(span).to.have.property('resource', resource)
                expect(span.meta).to.have.property('mongodb.query', query)
              })
              .then(done)
              .catch(done)

            collection.find({
              _id: new BSON.ObjectID(id)
            }).toArray()
          })

          it('should stringify BSON objects', done => {
            agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                const resource = `find test.${collectionName}`
                const query = '{"_time":{"$timestamp":"0"}}'

                expect(span).to.have.property('resource', resource)
                expect(span.meta).to.have.property('mongodb.query', query)
              })
              .then(done)
              .catch(done)

            collection.find({
              _time: new BSON.Timestamp()
            }).toArray()
          })

          it('should stringify BSON internal types', done => {
            agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                const resource = `find test.${collectionName}`
                const query = '{"_id":"?"}'

                expect(span).to.have.property('resource', resource)
                expect(span.meta).to.have.property('mongodb.query', query)
              })
              .then(done)
              .catch(done)

            collection.find({
              _id: new BSON.MinKey()
            }).toArray()
          })

          it('should skip functions when sanitizing', done => {
            agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                const resource = `find test.${collectionName}`
                const query = '{"_id":"1234"}'

                expect(span).to.have.property('resource', resource)
                expect(span.meta).to.have.property('mongodb.query', query)
              })
              .then(done)
              .catch(done)

            collection.find({
              _id: '1234',
              foo: () => {}
            }).toArray()
          })

          it('should log the aggregate pipeline in mongodb.query', done => {
            agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                const resource = 'aggregate test.$cmd'
                const query = '[{"$match":{"_id":"1234"}},{"$project":{"_id":1}}]'

                expect(span).to.have.property('resource', resource)
                expect(span.meta).to.have.property('mongodb.query', query)
              })
              .then(done)
              .catch(done)

            collection.aggregate([
              { $match: { _id: '1234' } },
              { $project: { _id: 1 } }
            ]).toArray()
          })

          it('should use the toJSON method of objects if it exists', done => {
            const id = '123456781234567812345678'

            agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                const resource = `find test.${collectionName}`
                const query = `{"_id":"${id}"}`

                expect(span).to.have.property('resource', resource)
                expect(span.meta).to.have.property('mongodb.query', query)
              })
              .then(done)
              .catch(done)

            collection.find({
              _id: { toJSON: () => id }
            }).toArray()
          })

          it('should run the callback in the parent context', done => {
            const insertPromise = collection.insertOne({ a: 1 }, {}, () => {
              expect(tracer.scope().active()).to.be.null
              done()
            })
            if (insertPromise && insertPromise.then) {
              insertPromise.then(() => {
                expect(tracer.scope().active()).to.be.null
                done()
              })
            }
          })

          withNamingSchema(
            () => collection.insertOne({ a: 1 }, {}, () => {}),
            rawExpectedSchema.outbound
          )
        })
      })

      describe('with configuration', () => {
        before(() => {
          return agent.load('mongodb-core', {
            service: 'custom',
            queryInResourceName: true
          })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(async () => {
          client = await createClient()
          db = client.db('test')
          collection = db.collection(collectionName)
        })

        it('should be configured with the correct values', done => {
          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', 'custom')
            })
            .then(done)
            .catch(done)

          collection.insertOne({ a: 1 }, {}, () => {})
        })

        it('should include sanitized query in resource when configured', done => {
          agent
            .assertSomeTraces(traces => {
              const span = traces[0][0]
              const resource = `find test.${collectionName} {"_bin":"?"}`

              expect(span).to.have.property('resource', resource)
            })
            .then(done)
            .catch(done)

          collection.find({
            _bin: new BSON.Binary()
          }).toArray()
        })

        withNamingSchema(
          () => collection.insertOne({ a: 1 }, () => {}),
          {
            v0: {
              opName: 'mongodb.query',
              serviceName: 'custom'
            },
            v1: {
              opName: 'mongodb.query',
              serviceName: 'custom'
            }
          }
        )
      })

      describe('with dbmPropagationMode service', () => {
        before(() => {
          return agent.load('mongodb-core', {
            dbmPropagationMode: 'service'
          })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(async () => {
          client = await createClient()
          db = client.db('test')
          collection = db.collection(collectionName)

          startSpy = sinon.spy(MongodbCorePlugin.prototype, 'start')
        })

        afterEach(() => {
          startSpy?.restore()
        })

        it('DBM propagation should inject service mode as comment', done => {
          agent
            .assertSomeTraces(traces => {
              const span = traces[0][0]

              expect(startSpy.called).to.be.true
              const { comment } = startSpy.getCall(0).args[0].ops
              expect(comment).to.equal(
                `dddb='${encodeURIComponent(span.meta['db.name'])}',` +
                'dddbs=\'test-mongodb\',' +
                'dde=\'tester\',' +
                `ddh='${encodeURIComponent(span.meta['out.host'])}',` +
                `ddps='${encodeURIComponent(span.meta.service)}',` +
                `ddpv='${ddpv}',` +
                `ddprs='${encodeURIComponent(span.meta['peer.service'])}'`
              )
            })
            .then(done)
            .catch(done)

          collection.find({
            _id: Buffer.from('1234')
          }).toArray()
        })
      })

      describe('with dbmPropagationMode full', () => {
        before(() => {
          return agent.load('mongodb-core', {
            dbmPropagationMode: 'full'
          })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(async () => {
          client = await createClient()
          db = client.db('test')
          collection = db.collection(collectionName)

          startSpy = sinon.spy(MongodbCorePlugin.prototype, 'start')
        })

        afterEach(() => {
          startSpy?.restore()
        })

        it('DBM propagation should inject full mode with traceparent as comment', done => {
          agent
            .assertSomeTraces(traces => {
              const span = traces[0][0]
              const traceId = span.meta['_dd.p.tid'] + span.trace_id.toString(16).padStart(16, '0')
              const spanId = span.span_id.toString(16).padStart(16, '0')

              expect(startSpy.called).to.be.true
              const { comment } = startSpy.getCall(0).args[0].ops
              expect(comment).to.equal(
                `dddb='${encodeURIComponent(span.meta['db.name'])}',` +
                'dddbs=\'test-mongodb\',' +
                'dde=\'tester\',' +
                `ddh='${encodeURIComponent(span.meta['out.host'])}',` +
                `ddps='${encodeURIComponent(span.meta.service)}',` +
                `ddpv='${ddpv}',` +
                `ddprs='${encodeURIComponent(span.meta['peer.service'])}',` +
                `traceparent='00-${traceId}-${spanId}-00'`
              )
            })
            .then(done)
            .catch(done)

          collection.find({
            _id: Buffer.from('1234')
          }).toArray()
        })
      })

      describe('with heartbeatEnabled configuration', () => {
        describe('when heartbeat tracing is disabled via config', () => {
          before(() => {
            return agent.load('mongodb-core', {
              heartbeatEnabled: false
            })
          })

          after(() => {
            return agent.close({ ritmReset: false })
          })

          beforeEach(async () => {
            client = await createClient()
            db = client.db('test')
          })

          it('should NOT create a span for heartbeat commands', (done) => {
            const parentSpan = tracer.startSpan('test.parent')

            agent
              .assertSomeTraces(traces => {
                // Should only receive the trace for the parent span
                expect(traces[0]).to.have.length(1)
                const span = traces[0][0]
                expect(span.name).to.equal('test.parent')
              })
              .then(done)

            // Activate parent span scope and trigger heartbeat command
            tracer.scope().activate(parentSpan, async () => {
              // Admin connect should be all that is needed to trigger heartbeat command for newer versions of mongo
              client = await createClient()
              db = client.db('test')

              // but we should send a test heartbeat command since older versions of mongo don't auto-send heartbeats
              db.command({ hello: 1 })
              setTimeout(() => parentSpan.finish(), 50)
            })
          })
        })

        describe('when heartbeat tracing is enabled via config (default)', () => {
          before(() => {
            return agent.load('mongodb-core', {
              heartbeatEnabled: true
            })
          })

          after(() => {
            return agent.close({ ritmReset: false })
          })

          beforeEach(async () => {
            client = await createClient()
            db = client.db('test')
          })

          it('should create a child span for heartbeat commands', (done) => {
            const parentSpan = tracer.startSpan('test.parent')

            agent
              .assertSomeTraces(traces => {
                expect(traces[0]).to.have.length.at.least(2)
                const rootSpan = traces[0][0]

                expect(rootSpan.name).to.equal('test.parent')

                // assert that some child spans were created, these are the heartbeat spans
                // don't assert on exact number of spans because it's dynamic
                for (const childSpan of traces[0].slice(1)) {
                  expect(childSpan.name).to.equal(expectedSchema.outbound.opName)
                  expect(childSpan.parent_id.toString()).to.equal(rootSpan.span_id.toString()) // Verify parent-child
                }
              })
              .then(done)

            // Activate parent span scope and trigger heartbeat command
            tracer.scope().activate(parentSpan, async () => {
              // Admin connect should be all that is needed to trigger heartbeat command for newer versions of mongo
              client = await createClient()
              db = client.db('test')

              // but we should send a test heartbeat command since older versions of mongo don't auto-send heartbeats
              db.command({ hello: 1 })
              setTimeout(() => parentSpan.finish(), 200)
            })
          })
        })

        describe('when heartbeat tracing is disabled via env var', () => {
          before(() => {
            process.env.DD_TRACE_MONGODB_HEARTBEAT_ENABLED = 'false'
            return agent.load('mongodb-core', {})
          })

          after(() => {
            return agent.close({ ritmReset: false })
          })

          beforeEach(async () => {
            client = await createClient()
            db = client.db('test')
          })

          it('should NOT create a span for heartbeat commands', (done) => {
            const parentSpan = tracer.startSpan('test.parent')

            agent
              .assertSomeTraces(traces => {
                // Should only receive the trace for the parent span
                expect(traces[0]).to.have.length(1)
                const span = traces[0][0]
                expect(span.name).to.equal('test.parent')
              })
              .then(done)

            // Activate parent span scope and trigger heartbeat command
            tracer.scope().activate(parentSpan, async () => {
              // Admin connect should be all that is needed to trigger heartbeat command for newer versions of mongo
              client = await createClient()
              db = client.db('test')

              // but we should send a test heartbeat command since older versions of mongo don't auto-send heartbeats
              db.command({ hello: 1 })
              setTimeout(() => parentSpan.finish(), 50)
            })
          })
        })

        describe('when heartbeat tracing is enabled via env var', () => {
          before(() => {
            process.env.DD_TRACE_MONGODB_HEARTBEAT_ENABLED = 'true'
            return agent.load('mongodb-core', {})
          })

          after(() => {
            return agent.close({ ritmReset: false })
          })

          beforeEach(async () => {
            client = await createClient()
            db = client.db('test')
          })

          it('should create a child span for heartbeat commands', (done) => {
            const parentSpan = tracer.startSpan('test.parent')

            agent
              .assertSomeTraces(traces => {
                expect(traces[0]).to.have.length.at.least(2)
                const rootSpan = traces[0][0]

                expect(rootSpan.name).to.equal('test.parent')

                // assert that some child spans were created, these are the heartbeat spans
                // don't assert on exact number of spans because it's dynamic
                for (const childSpan of traces[0].slice(1)) {
                  expect(childSpan.name).to.equal(expectedSchema.outbound.opName)
                  expect(childSpan.parent_id.toString()).to.equal(rootSpan.span_id.toString()) // Verify parent-child
                }
              })
              .then(done)

            // Activate parent span scope and trigger heartbeat command
            tracer.scope().activate(parentSpan, async () => {
              // Admin connect should be all that is needed to trigger heartbeat command for newer versions of mongo
              client = await createClient()
              db = client.db('test')

              // but we should send a test heartbeat command since older versions of mongo don't auto-send heartbeats
              db.command({ hello: 1 })
              setTimeout(() => parentSpan.finish(), 200)
            })
          })
        })
      })
    })
  })
})
