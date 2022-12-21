'use strict'

const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')

const withTopologies = fn => {
  withVersions('mongodb-core', 'mongodb', (version, moduleName) => {
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

  describe('mongodb-core', () => {
    withTopologies(createClient => {
      beforeEach(() => {
        id = require('../../dd-trace/src/id')
        tracer = require('../../dd-trace')

        collectionName = id().toString()

        BSON = require(`../../../versions/bson@4.0.0`).get()
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
          it('should do automatic instrumentation', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                const resource = `insert test.${collectionName}`

                expect(span).to.have.property('name', 'mongodb.query')
                expect(span).to.have.property('service', 'test-mongodb')
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
              .use(traces => {
                const span = traces[0][0]
                const resource = `planCacheListPlans test.$cmd`
                const query = `{}`

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
              .use(traces => {
                const span = traces[0][0]
                const resource = `find test.${collectionName}`
                const query = `{"_id":"?"}`

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
              .use(traces => {
                const span = traces[0][0]
                const resource = `find test.${collectionName}`
                const query = `{"_bin":"?"}`

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
              .use(traces => {
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
              .use(traces => {
                const span = traces[0][0]
                const resource = `find test.${collectionName}`
                const query = `{"_time":{"$timestamp":"0"}}`

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
              .use(traces => {
                const span = traces[0][0]
                const resource = `find test.${collectionName}`
                const query = `{"_id":"?"}`

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
              .use(traces => {
                const span = traces[0][0]
                const resource = `find test.${collectionName}`
                const query = `{"_id":"1234"}`

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

          it('should run the callback in the parent context', done => {
            collection.insertOne({ a: 1 }, {}, () => {
              expect(tracer.scope().active()).to.be.null
              done()
            })
          })
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
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', 'custom')
            })
            .then(done)
            .catch(done)

          collection.insertOne({ a: 1 }, {}, () => {})
        })

        it('should include sanitized query in resource when configured', done => {
          agent
            .use(traces => {
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
      })
    })
  })
})
