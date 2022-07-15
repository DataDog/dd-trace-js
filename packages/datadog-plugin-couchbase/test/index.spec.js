'use strict'

const { expect } = require('chai')
const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
const proxyquire = require('proxyquire').noPreserveCache()

function withSemverGTE3 (version, option1, option2) {
  option1 = option1 || (() => {})
  option2 = option2 || (() => {})

  if (semver.intersects('>=3.0.0', version)) {
    option1()
  } else {
    option2()
  }
}

describe('Plugin', () => {
  let couchbase
  let N1qlQuery
  let cluster
  let bucket
  let tracer
  let collection

  describe('couchbase', () => {
    withVersions('couchbase', 'couchbase', version => {
      beforeEach(() => {
        tracer = global.tracer = require('../../dd-trace')
      })

      describe('without configuration', () => {
        beforeEach(() => {
          return agent.load('couchbase').then(() => {
            couchbase = proxyquire(`../../../versions/couchbase@${version}`, {}).get()
            N1qlQuery = couchbase.N1qlQuery
          })
        })

        beforeEach(done => {
          withSemverGTE3(version, () => {
            couchbase.connect('couchbase://localhost', {
              username: 'Administrator',
              password: 'password'
            }).then(_cluster => {
              cluster = _cluster
              bucket = cluster.bucket('datadog-test')
              collection = bucket.defaultCollection()
            }).then(done).catch(done)
          }, () => {
            cluster = new couchbase.Cluster('localhost:8091')
            cluster.authenticate('Administrator', 'password')
            cluster.enableCbas('localhost:8095')
            bucket = cluster.openBucket('datadog-test', (err) => done(err))
          })
        })

        afterEach(() => {
          withSemverGTE3(version, async () => { await cluster.close() }, () => { bucket.disconnect() })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        it('should run the Query callback in the parent context', done => {
          const query = 'SELECT 1+1'
          const span = tracer.startSpan('test.query.cb')

          tracer.scope().activate(span, () => {
            withSemverGTE3(version, () => {
              cluster.query(query).then(rows => {
                expect(tracer.scope().active()).to.equal(span)
              }).then(done)
                .catch(done)
            }, () => {
              const n1qlQuery = N1qlQuery.fromString(query)
              cluster.query(n1qlQuery, (err, rows) => {
                expect(tracer.scope().active()).to.equal(span)
                done(err)
              })
            })
          })
        })

        it('should run any Bucket or Collection operations in the parent context', done => {
          const span = tracer.startSpan('test')

          tracer.scope().activate(span, () => {
            withSemverGTE3(version, () => {
              collection.exists('1').then(() => {
                expect(tracer.scope().active()).to.equal(span)
              }).then(done).catch(done)
            }, () => {
              bucket.get('1', () => {
                expect(tracer.scope().active()).to.equal(span)
                done()
              })
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
                withSemverGTE3(version, undefined, () => {
                  expect(span.meta).to.have.property('couchbase.bucket.name', 'datadog-test')
                })
              })
              .then(done)
              .catch(done)

            withSemverGTE3(version, () => {
              cluster.query(query).catch(done)
            }, () => {
              const n1qlQuery = N1qlQuery.fromString(query)
              cluster.query(n1qlQuery, (err) => {
                if (err) done(err)
              })
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
                withSemverGTE3(version, () => {
                  expect(span.meta).to.have.property('couchbase.collection.name', '_default')
                })
              })
              .then(done)
              .catch(done)

            withSemverGTE3(version, () => {
              collection.upsert('testdoc', { name: 'Frank' }).catch(err => done(err))
            }, () => {
              bucket.upsert('testdoc', { name: 'Frank' }, (err, result) => {
                if (err) done(err)
              })
            })
          })

          it('should skip instrumentation for invalid arguments', (done) => {
            withSemverGTE3(version, () => {
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
            }, () => {
              try {
                bucket.upsert('testdoc', { name: 'Frank' })
              } catch (e) {
                expect(e.message).to.equal('Third argument needs to be an object or callback.')
                done()
              }
            })
          })
        })

        withSemverGTE3(version, () => {
          describe('operations on sdk >=3 still work with callbacks', () => {
            it('should perform operation with no error', done => {
              const query = 'SELECT 1+1'

              agent
                .use(traces => {
                  const span = traces[0][0]
                  expect(span).to.have.property('name', 'couchbase.query')
                  expect(span).to.have.property('service', 'test-couchbase')
                  expect(span).to.have.property('resource', query)
                  expect(span).to.have.property('type', 'sql')
                  expect(span.meta).to.have.property('span.kind', 'client')
                })
                .then(done)
                .catch(done)

              // instead of catching promise-based error
              cluster.query(query, (err) => { if (err) done(err) })
            })
          })

          it('should catch error in callback', done => {
            const invalidIndex = '-1'
            collection.get(invalidIndex, (err) => { if (err) done() })
          })
        })

        // after v3, buckets no longer support querying
        // TODO: bucket viewquery?
        withSemverGTE3(version, undefined, () => {
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
    })
  })
})
