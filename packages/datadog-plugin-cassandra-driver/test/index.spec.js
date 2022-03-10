'use strict'

const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')

describe('Plugin', () => {
  let cassandra
  let tracer

  describe('cassandra-driver', () => {
    withVersions('cassandra-driver', 'cassandra-driver', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
        global.tracer = tracer
      })

      describe('without configuration', () => {
        let client

        before(() => {
          return agent.load('cassandra-driver')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(done => {
          cassandra = require(`../../../versions/cassandra-driver@${version}`).get()

          client = new cassandra.Client({
            contactPoints: ['127.0.0.1'],
            localDataCenter: 'datacenter1',
            keyspace: 'system'
          })

          client.connect(done)
        })

        afterEach(done => {
          client.shutdown(done)
        })

        it('should do automatic instrumentation', done => {
          const query = 'SELECT now() FROM local;'
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', 'test-cassandra')
              expect(traces[0][0]).to.have.property('resource', query)
              expect(traces[0][0]).to.have.property('type', 'cassandra')
              expect(traces[0][0].meta).to.have.property('db.type', 'cassandra')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('out.host', '127.0.0.1')
              expect(traces[0][0].meta).to.have.property('out.port', '9042')
              expect(traces[0][0].meta).to.have.property('cassandra.query', query)
              expect(traces[0][0].meta).to.have.property('cassandra.keyspace', 'system')
            })
            .then(done)
            .catch(done)

          client.execute(query, err => err && done(err))
        })

        it('should support batch queries', done => {
          const id = '1234'
          const queries = [
            { query: 'INSERT INTO test.test (id) VALUES (?)', params: [id] },
            `UPDATE test.test SET test='test' WHERE id='${id}';`
          ]

          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('resource', `${queries[0].query}; ${queries[1]}`)
            })
            .then(done)
            .catch(done)

          client.batch(queries, { prepare: true }, err => err && done(err))
        })

        it('should support batch queries without a callback', done => {
          const id = '1234'
          const queries = [
            { query: 'INSERT INTO test.test (id) VALUES (?)', params: [id] },
            `UPDATE test.test SET test='test' WHERE id='${id}';`
          ]

          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('resource', `${queries[0].query}; ${queries[1]}`)
            })
            .then(done)
            .catch(done)

          try {
            client.batch(queries, { prepare: true })
          } catch (e) {
            // older versions require a callback
          }
        })

        it('should handle errors', done => {
          let error

          agent
            .use(traces => {
              expect(traces[0][0].meta).to.have.property('error.type', error.name)
              expect(traces[0][0].meta).to.have.property('error.msg', error.message)
              expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
            })
            .then(done)
            .catch(done)

          client.execute('INVALID;', err => {
            error = err
          })
        })

        it('should run the callback in the parent context', done => {
          const scope = tracer.scope()
          const childOf = tracer.startSpan('test')

          scope.activate(childOf, () => {
            client.execute('SELECT now() FROM local;', () => {
              expect(tracer.scope().active()).to.equal(childOf)
              done()
            })
          })
        })

        it('should run the batch callback in the parent context', done => {
          const scope = tracer.scope()
          const childOf = tracer.startSpan('test')

          scope.activate(childOf, () => {
            client.batch([`UPDATE test.test SET test='test' WHERE id='1234';`], () => {
              expect(tracer.scope().active()).to.equal(childOf)
              done()
            })
          })
        })
      })

      describe('with configuration', () => {
        let client

        before(() => {
          return agent.load('cassandra-driver', { service: 'custom' })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(done => {
          cassandra = require(`../../../versions/cassandra-driver@${version}`).get()

          client = new cassandra.Client({
            contactPoints: ['127.0.0.1'],
            localDataCenter: 'datacenter1',
            keyspace: 'system'
          })

          client.keyspace

          client.connect(done)
        })

        afterEach(done => {
          client.shutdown(done)
        })

        it('should be configured with the correct values', done => {
          agent.use(traces => {
            expect(traces[0][0]).to.have.property('service', 'custom')
            done()
          })

          client.execute('SELECT now() FROM local;', err => err && done(err))
        })
      })

      // Promise support added in 3.2.0
      if (semver.intersects(version, '>=3.2.0')) {
        describe('with the promise API', () => {
          let client

          before(() => {
            return agent.load('cassandra-driver')
          })

          after(() => {
            return agent.close({ ritmReset: false })
          })

          beforeEach(done => {
            cassandra = require(`../../../versions/cassandra-driver@${version}`).get()

            client = new cassandra.Client({
              contactPoints: ['127.0.0.1'],
              localDataCenter: 'datacenter1',
              keyspace: 'system'
            })

            client.keyspace

            client.connect(done)
          })

          afterEach(done => {
            client.shutdown(done)
          })

          it('should do automatic instrumentation', done => {
            const query = 'SELECT now() FROM local;'

            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('service', 'test-cassandra')
                expect(traces[0][0]).to.have.property('resource', query)
                expect(traces[0][0]).to.have.property('type', 'cassandra')
                expect(traces[0][0].meta).to.have.property('db.type', 'cassandra')
                expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                expect(traces[0][0].meta).to.have.property('out.host', '127.0.0.1')
                expect(traces[0][0].meta).to.have.property('out.port', '9042')
                expect(traces[0][0].meta).to.have.property('cassandra.query', query)
                expect(traces[0][0].meta).to.have.property('cassandra.keyspace', 'system')
              })
              .then(done)
              .catch(done)

            client.execute(query)
              .catch(done)
          })

          it('should support batch queries', done => {
            const id = '1234'
            const queries = [
              { query: 'INSERT INTO test.test (id) VALUES (?)', params: [id] },
              `UPDATE test.test SET test='test' WHERE id='${id}';`
            ]

            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', `${queries[0].query}; ${queries[1]}`)
              })
              .then(done)
              .catch(done)

            client.batch(queries, { prepare: true })
              .catch(done)
          })
        })
      }
    })
  })
})
