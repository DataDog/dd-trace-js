'use strict'

const { expect } = require('chai')
const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
const proxyquire = require('proxyquire').noPreserveCache()

describe('Plugin', () => {
  let couchbase
  let N1qlQuery
  let cluster
  let bucket
  let tracer

  describe('couchbase', () => {
    withVersions('couchbase', 'couchbase', version => {
      beforeEach(() => {
        tracer = global.tracer = require('../../dd-trace')
      })

      describe('without configuration', () => {
        beforeEach(() => {
          // debugger;
          return agent.load('couchbase').then(() => {
            // couchbase = require(`../../../versions/couchbase@${version}`).get()
            couchbase = proxyquire(`../../../versions/couchbase@${version}`, {}).get()
            N1qlQuery = couchbase.N1qlQuery
          })
        })

        beforeEach(done => {
          // debugger;
          cluster = new couchbase.Cluster('localhost:8091')
          cluster.authenticate('Administrator', 'password')
          cluster.enableCbas('localhost:8095')
          bucket = cluster.openBucket('datadog-test', (err) => done(err))
        })

        afterEach(() => {
          bucket.disconnect()
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        it('should run the Query callback in the parent context', done => {
          debugger;
          const query = 'SELECT 1+1'
          const n1qlQuery = N1qlQuery.fromString(query)
          const span = tracer.startSpan('test.query.cb')

          tracer.scope().activate(span, () => {
            debugger;
            cluster.query(n1qlQuery, (err, rows) => {
              debugger;
              expect(tracer.scope().active()).to.equal(span)
              done(err)
            })
          })
        })

        it.only('should run the Query event listener in the parent context', done => {
          debugger;
          const query = 'SELECT 1+1'
          const n1qlQuery = N1qlQuery.fromString(query)
          const span = tracer.startSpan('test.query.listener')

          const emitter = cluster.query(n1qlQuery)

          tracer.scope().activate(span, () => {
            debugger;
            // console.log(tracer.scope().active())
            emitter.on('rows', () => {
              debugger;
              console.log(tracer.scope().active())
              expect(tracer.scope().active()).to.equal(span)
              done()
            })
          })
        })

        it('should run the Bucket event listener in the parent context', done => {
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

        it('should run any Bucket operations in the parent context', done => {
          const span = tracer.startSpan('test')

          tracer.scope().activate(span, () => {
            bucket.get('1', () => {
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
                expect(span).to.have.property('name', 'couchbase.query')
                expect(span).to.have.property('service', 'test-couchbase')
                expect(span).to.have.property('resource', query)
                expect(span).to.have.property('type', 'sql')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('couchbase.bucket.name', 'datadog-test')
              })
              .then(done)
              .catch(done)

            cluster.query(n1qlQuery, (err) => {
              if (err) done(err)
            })

            if (semver.intersects(version, '2.4.0 - 2.5.0')) {
              // Due to bug JSCBC-491 in Couchbase, we have to reconnect to dispatch waiting queries
              const triggerBucket = cluster.openBucket('datadog-test', (err) => {
                if (err) done(err)
              })
              triggerBucket.on('connect', () => triggerBucket.disconnect())
            }
          })

          it('should handle storage queries', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', 'couchbase.upsert')
                expect(span).to.have.property('service', 'test-couchbase')
                expect(span).to.have.property('resource', 'couchbase.upsert')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('couchbase.bucket.name', 'datadog-test')
              })
              .then(done)
              .catch(done)

            bucket.upsert('testdoc', { name: 'Frank' }, (err, result) => {
              if (err) done(err)
            })
          })

          it('should skip instrumentation for invalid arguments', () => {
            try {
              bucket.upsert('testdoc', { name: 'Frank' })
            } catch (e) {
              expect(e.message).to.equal('Third argument needs to be an object or callback.')
            }
          })
        })

        describe('queries on buckets', () => {
          it('should handle N1QL queries', done => {
            const query = 'SELECT 1+2'
            const n1qlQuery = N1qlQuery.fromString(query)

            agent
              .use(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', 'couchbase.query')
                expect(span).to.have.property('service', 'test-couchbase')
                expect(span).to.have.property('resource', query)
                expect(span).to.have.property('type', 'sql')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('couchbase.bucket.name', 'datadog-test')
              })
              .then(done)
              .catch(done)

            bucket.query(n1qlQuery, (err) => {
              if (err) done(err)
            })
          })
        })
      })
    })
  })
})
