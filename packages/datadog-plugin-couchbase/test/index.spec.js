'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

wrapIt()

describe('Plugin', () => {
  let couchbase
  let N1qlQuery
  let ViewQuery
  let SearchQuery
  let CbasQuery
  let cluster
  let bucket
  let tracer

  describe('couchbase', () => {
    withVersions(plugin, 'couchbase', version => {
      beforeEach(() => {
        tracer = global.tracer = require('../../dd-trace')
      })

      describe('without configuration', () => {
        beforeEach(() => {
          return agent.load(plugin, 'couchbase').then(() => {
            couchbase = require(`../../../versions/couchbase@${version}`).get()
            N1qlQuery = couchbase.N1qlQuery
            ViewQuery = couchbase.ViewQuery
            SearchQuery = couchbase.SearchQuery
            CbasQuery = couchbase.CbasQuery
          })
        })

        beforeEach(done => {
          cluster = new couchbase.Cluster('couchbase://localhost')
          cluster.authenticate('Administrator', 'password')
          bucket = cluster.openBucket('datadog-test', (err) => {
            done(err)
          })
          cluster.enableCbas('couchbase://localhost')
        })

        afterEach(() => {
          bucket.disconnect()
        })

        after(() => {
          return agent.close()
        })

        it('should run the Query callback in the parent context', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()
          const query = 'SELECT 1+1'
          const n1qlQuery = N1qlQuery.fromString(query)
          const span = tracer.startSpan('test.query.cb')

          tracer.scope().activate(span, () => {
            cluster.query(n1qlQuery, (err, rows) => {
              expect(tracer.scope().active()).to.equal(span)
              done(err)
            })
          })
        })

        it('should run the Query event listener in the parent context', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()
          const query = 'SELECT 1+1'
          const n1qlQuery = N1qlQuery.fromString(query)
          const span = tracer.startSpan('test.query.listener')

          const emitter = cluster.query(n1qlQuery)

          tracer.scope().activate(span, () => {
            emitter.on('rows', () => {
              expect(tracer.scope().active()).to.equal(span)
              done()
            })
          })
        })

        it('should run the Bucket event listener in the parent context', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()
          bucket.disconnect()
          const span = tracer.startSpan('test')

          bucket = cluster.openBucket('datadog-test')

          tracer.scope().activate(span, () => {
            bucket.on('connect', () => {
              expect(tracer.scope().active()).to.equal(span)
              done()
            })
          })
        })

        describe('queries on cluster', () => {
          it('should handle N1QL queries', done => {
            const query = 'SELECT 1+1'
            const n1qlQuery = N1qlQuery.fromString(query)

            agent
              .use(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', 'couchbase.call')
                expect(span).to.have.property('service', 'test-couchbase')
                expect(span).to.have.property('resource', query)
                expect(span).to.have.property('type', 'sql')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('bucket', 'datadog-test')
                expect(span.meta).to.have.property('query.type', 'n1ql')
              })
              .then(done)
              .catch(done)

            cluster.query(n1qlQuery, (err) => {
              if (err) done(err)
            })
          })

          it('should handle Search queries', done => {
            const index = 'test'
            const searchQuery = SearchQuery.new(index, SearchQuery.queryString('eiffel'))

            agent
              .use(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', 'couchbase.call')
                expect(span).to.have.property('service', 'test-couchbase')
                expect(span).to.have.property('resource', index)
                expect(span).to.have.property('type', 'sql')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('bucket', 'datadog-test')
                expect(span.meta).to.have.property('query.type', 'search')
              })
              .then(done)
              .catch(done)

            cluster.query(searchQuery, (err) => {
              if (err) done(err)
            })
          })

          it('should handle Analytics queries', done => {
            const query = 'SELECT * FROM datatest'
            const cbasQuery = CbasQuery.fromString(query)

            agent
              .use(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', 'couchbase.call')
                expect(span).to.have.property('service', 'test-couchbase')
                expect(span).to.have.property('resource', query)
                expect(span).to.have.property('type', 'sql')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('bucket', 'datadog-test')
                expect(span.meta).to.have.property('query.type', 'cbas')
              })
              .then(done)
              .catch(done)

            cluster.query(cbasQuery, (err) => {
              if (err) done(err)
            })
          })
        })

        describe('queries on buckets', () => {
          it('should handle N1QL queries', done => {
            const query = 'SELECT 1+1'
            const n1qlQuery = N1qlQuery.fromString(query)

            agent
              .use(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', 'couchbase.call')
                expect(span).to.have.property('service', 'test-couchbase')
                expect(span).to.have.property('resource', query)
                expect(span).to.have.property('type', 'sql')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('bucket', 'datadog-test')
                expect(span.meta).to.have.property('query.type', 'n1ql')
              })
              .then(done)
              .catch(done)

            cluster.query(n1qlQuery, (err) => {
              if (err) done(err)
            })
          })

          it('should handle View queries ', done => {
            const viewQuery = ViewQuery.from('datadoc', 'by_name')

            agent
              .use(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', 'couchbase.call')
                expect(span).to.have.property('service', 'test-couchbase')
                expect(span).to.have.property('resource', viewQuery.name)
                expect(span).to.have.property('type', 'sql')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('bucket', 'datadog-test')
                expect(span.meta).to.have.property('ddoc', viewQuery.ddoc)
                expect(span.meta).to.have.property('query.type', 'view')
              })
              .then(done)
              .catch(done)

            bucket.query(viewQuery, (err) => {
              if (err) done(err)
            })
          })

          it('should handle Search queries', done => {
            const index = 'test'
            const searchQuery = SearchQuery.new(index, SearchQuery.queryString('eiffel'))

            agent
              .use(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', 'couchbase.call')
                expect(span).to.have.property('service', 'test-couchbase')
                expect(span).to.have.property('resource', index)
                expect(span).to.have.property('type', 'sql')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('bucket', 'datadog-test')
                expect(span.meta).to.have.property('query.type', 'search')
              })
              .then(done)
              .catch(done)

            bucket.query(searchQuery, (err) => {
              if (err) done(err)
            })
          })

          it('should handle Analytics queries', done => {
            const query = 'SELECT * FROM datatest'
            const cbasQuery = CbasQuery.fromString(query)

            agent
              .use(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', 'couchbase.call')
                expect(span).to.have.property('service', 'test-couchbase')
                expect(span).to.have.property('resource', query)
                expect(span).to.have.property('type', 'sql')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('bucket', 'datadog-test')
                expect(span.meta).to.have.property('query.type', 'cbas')
              })
              .then(done)
              .catch(done)

            bucket.query(cbasQuery, (err) => {
              if (err) done(err)
            })
          })
        })
      })
    })
  })
})
