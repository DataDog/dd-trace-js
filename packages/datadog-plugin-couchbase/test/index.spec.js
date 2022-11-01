'use strict'

const { expect } = require('chai')
const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
const proxyquire = require('proxyquire').noPreserveCache()

describe('Plugin', () => {
  let couchbase

  describe('couchbase', () => {
    let cluster
    let bucket
    let tracer
    let collection

    before(() => {
      tracer = global.tracer = require('../../dd-trace')
    })

    withVersions('couchbase', 'couchbase', '<3.0.0', version => {
      let N1qlQuery
      describe('without configuration', () => {
        beforeEach(done => {
          agent.load('couchbase').then(() => {
            couchbase = proxyquire(`../../../versions/couchbase@${version}`, {}).get()
            N1qlQuery = couchbase.N1qlQuery
            cluster = new couchbase.Cluster('localhost:8091')
            cluster.authenticate('Administrator', 'password')
            cluster.enableCbas('localhost:8095')
            bucket = cluster.openBucket('datadog-test', (err) => done(err))
          })
        })

        afterEach(() => {
          bucket.disconnect()
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        it('should run the Query callback in the parent context', done => {
          const query = 'SELECT 1+1'
          const span = tracer.startSpan('test.query.cb')

          tracer.scope().activate(span, () => {
            const n1qlQuery = N1qlQuery.fromString(query)
            cluster.query(n1qlQuery, (err, rows) => {
              expect(tracer.scope().active()).to.equal(span)
              done(err)
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

            agent
              .use(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', 'couchbase.query')
                expect(span).to.have.property('service', 'test-couchbase')
                expect(span).to.have.property('resource', query)
                expect(span).to.have.property('type', 'sql')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('couchbase.bucket.name', 'datadog-test')
                expect(span.meta).to.have.property('component', 'couchbase')
              })
              .then(done)
              .catch(done)

            const n1qlQuery = N1qlQuery.fromString(query)
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

          it('should skip instrumentation for invalid arguments', (done) => {
            try {
              bucket.upsert('testdoc', { name: 'Frank' })
            } catch (e) {
              expect(e.message).to.equal('Third argument needs to be an object or callback.')
              done()
            }
          })
        })

        describe('queries on buckets', () => {
          it('should handle N1QL queries', done => {
            const query = 'SELECT 1+2'

            agent
              .use(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', 'couchbase.query')
                expect(span).to.have.property('service', 'test-couchbase')
                expect(span).to.have.property('resource', query)
                expect(span).to.have.property('type', 'sql')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('couchbase.bucket.name', 'datadog-test')
                expect(span.meta).to.have.property('component', 'couchbase')
              })
              .then(done)
              .catch(done)

            const n1qlQuery = N1qlQuery.fromString(query)
            bucket.query(n1qlQuery, (err) => {
              if (err) done(err)
            })
          })
        })
      })
    })

    withVersions('couchbase', 'couchbase', '>=3.0.0', version => {
      beforeEach(() => {
        tracer = global.tracer = require('../../dd-trace')
      })

      describe('without configuration', () => {
        beforeEach(done => {
          agent.load('couchbase').then(() => {
            couchbase = proxyquire(`../../../versions/couchbase@${version}`, {}).get()
            couchbase.connect('couchbase://localhost', {
              username: 'Administrator',
              password: 'password'
            }).then(_cluster => {
              cluster = _cluster
              bucket = cluster.bucket('datadog-test')
              collection = bucket.defaultCollection()
            }).then(done).catch(done)
          })
        })

        afterEach(async () => {
          await cluster.close()
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        it('should run the Query callback in the parent context', done => {
          const query = 'SELECT 1+1'
          const span = tracer.startSpan('test.query.cb')

          tracer.scope().activate(span, () => {
            cluster.query(query).then(rows => {
              expect(tracer.scope().active()).to.equal(span)
            }).then(done)
              .catch(done)
          })
        })

        it('should run any Collection operations in the parent context', done => {
          const span = tracer.startSpan('test')
          tracer.scope().activate(span, () => {
            collection.exists('1').then(() => {
              expect(tracer.scope().active()).to.equal(span)
            }).then(done).catch(done)
          })
        })

        describe('queries on Cluster', () => {
          it('should handle N1QL queries', done => {
            const query = 'SELECT 1+1'

            agent
              .use(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', 'couchbase.query')
                expect(span).to.have.property('service', 'test-couchbase')
                expect(span).to.have.property('resource', query)
                expect(span).to.have.property('type', 'sql')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('component', 'couchbase')
              })
              .then(done)
              .catch(done)

            cluster.query(query).catch(done)
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
                expect(span.meta).to.have.property('couchbase.collection.name', '_default')
                expect(span.meta).to.have.property('component', 'couchbase')
              })
              .then(done)
              .catch(done)

            collection.upsert('testdoc', { name: 'Frank' }).catch(err => done(err))
          })

          it('should skip instrumentation for invalid arguments', (done) => {
            const checkError = (e) => {
              expect(e.message).to.be.oneOf([
                // depending on version of node
                'Cannot read property \'toString\' of undefined',
                'Cannot read properties of undefined (reading \'toString\')',
                'parsing failure' // sdk 4
              ])
              done()
            }
            try {
              cluster.query(undefined).catch(checkError) // catch bad errors
            } catch (e) {
              // catch errors conventionally as well
              checkError(e)
            }
          })
        })

        describe('operations still work with callbacks', () => {
          it('should perform normal cluster query operation with callback', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', 'couchbase.query')
                expect(span).to.have.property('service', 'test-couchbase')
                expect(span).to.have.property('resource', query)
                expect(span).to.have.property('type', 'sql')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('component', 'couchbase')
              })
              .then(done)
              .catch(done)

            const query = 'SELECT 1+1'
            cluster.query(query, (err, rows) => {
              if (err) done(err)
            })
          })
          describe('errors are handled correctly in callbacks', () => {
            it('should catch error in callback for non-traced functions', done => {
              const invalidIndex = '-1'
              collection.get(invalidIndex, (err) => { if (err) done() })
            })

            // due to bug in couchbase for these versions (see JSCBC-945)
            if (!semver.intersects('3.2.0 - 3.2.1', version)) {
              it('should catch errors in callback and report error in trace', done => {
                const invalidQuery = 'SELECT'
                const cb = sinon.spy()
                agent
                  .use(traces => {
                    const span = traces[0][0]
                    expect(cb).to.have.been.calledOnce
                    // different couchbase sdk versions will have different error messages/types
                    expect(span.error).to.equal(1)
                  }).then(done).catch(done)
                cluster.query(invalidQuery, cb)
              })
            }
          })
        })
      })
    })
  })
})
