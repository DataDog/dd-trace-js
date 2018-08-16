'use strict'

const agent = require('./agent')
const Buffer = require('safe-buffer').Buffer
const plugin = require('../../src/plugins/mongodb-core')

wrapIt()

describe('Plugin', () => {
  let mongo
  let server
  let platform
  let tracer
  let collection

  describe('mongodb-core', () => {
    withVersions(plugin, 'mongodb-core', version => {
      beforeEach(() => {
        platform = require('../../src/platform')
        tracer = require('../..')

        collection = platform.id().toString()
      })

      afterEach(() => {
        agent.close()
        server.destroy()
      })

      describe('without configuration', () => {
        beforeEach(done => {
          agent.load(plugin, 'mongodb-core')
            .then(() => {
              mongo = require(`./versions/mongodb-core@${version}`).get()

              server = new mongo.Server({
                host: 'localhost',
                port: 27017,
                reconnect: false
              })

              server.on('connect', () => done())
              server.on('error', done)

              server.connect()
            })
            .catch(done)
        })

        describe('server', () => {
          it('should do automatic instrumentation', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                const resource = `insert test.${collection}`

                expect(span).to.have.property('name', 'mongodb.query')
                expect(span).to.have.property('service', 'test-mongodb')
                expect(span).to.have.property('resource', resource)
                expect(span).to.have.property('type', 'mongodb')
                expect(span.meta).to.have.property('db.name', `test.${collection}`)
                expect(span.meta).to.have.property('out.host', 'localhost')
              })
              .then(done)
              .catch(done)

            server.insert(`test.${collection}`, [{ a: 1 }], {}, () => {})
          })

          it('should use the correct resource name for arbitrary commands', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                const resource = `planCacheListPlans test.${collection} {}`

                expect(span).to.have.property('resource', resource)
              })
              .then(done)
              .catch(done)

            server.command(`test.${collection}`, {
              planCacheListPlans: `test.${collection}`,
              query: {}
            }, () => {})
          })

          it('should use a fallback for unknown commands', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                const resource = `unknownCommand test.${collection}`

                expect(span).to.have.property('resource', resource)
              })
              .then(done)
              .catch(done)

            server.command(`test.${collection}`, {
              invalidCommand: `test.${collection}`
            }, () => {})
          })

          it('should sanitize the query as the resource', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                const resource = `find test.${collection} {"foo":"?","bar":{"baz":"?"}}`

                expect(span).to.have.property('resource', resource)
              })
              .then(done)
              .catch(done)

            server.command(`test.${collection}`, {
              find: `test.${collection}`,
              query: {
                foo: 1,
                bar: {
                  baz: [1, 2, 3]
                }
              }
            }, () => {})
          })

          it('should sanitize buffers as values and not as objects', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                const resource = `find test.${collection} {"_id":"?"}`

                expect(span).to.have.property('resource', resource)
              })
              .then(done)
              .catch(done)

            server.command(`test.${collection}`, {
              find: `test.${collection}`,
              query: {
                _id: Buffer.from('1234')
              }
            }, () => {})
          })

          it('should run the callback in the parent context', done => {
            server.insert(`test.${collection}`, [{ a: 1 }], {}, () => {
              expect(tracer.scopeManager().active()).to.be.null
              done()
            })
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

            server.insert('', [{ a: 1 }], (err) => {
              error = err
              server.destroy()
            })
          })
        })

        describe('cursor', () => {
          it('should do automatic instrumentation', done => {
            agent
              .use(traces => {
                const span = traces[0][0]

                expect(span).to.have.property('name', 'mongodb.query')
                expect(span).to.have.property('service', 'test-mongodb')
                expect(span).to.have.property('type', 'mongodb')
                expect(span.meta).to.have.property('db.name', `test.${collection}`)
                expect(span.meta).to.have.property('out.host', 'localhost')
                expect(span.meta).to.have.property('out.port', '27017')
              })
              .then(done)
              .catch(done)

            const cursor = server.cursor(`test.${collection}`, {
              insert: `test.${collection}`,
              documents: [{ a: 1 }]
            }, {})

            cursor.next()
          })

          it('should have the correct index', done => {
            let cursor

            agent.use(() => {
              cursor = server.cursor(`test.${collection}`, {
                find: `test.${collection}`,
                query: {}
              }, { batchSize: 1 })

              cursor.next()
            })

            agent
              .use(traces => {
                expect(traces[0][0].meta).to.have.property('mongodb.cursor.index', '0')
              })
              .then(() => cursor.next())
              .catch(done)

            agent
              .use(traces => {
                expect(traces[0][0].meta).to.have.property('mongodb.cursor.index', '1')
              })
              .then(done)
              .catch(done)

            server.insert(`test.${collection}`, [{ a: 1 }, { a: 2 }], {})
          })

          it('should sanitize the query as the resource', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                const resource = `find test.${collection} {"foo":"?","bar":{"baz":"?"}}`

                expect(span).to.have.property('resource', resource)
              })
              .then(done)
              .catch(done)

            const cursor = server.cursor(`test.${collection}`, {
              find: `test.${collection}`,
              query: {
                foo: 1,
                bar: {
                  baz: [1, 2, 3]
                }
              }
            })

            cursor.next()
          })

          it('should run the callback in the parent context', done => {
            const cursor = server.cursor(`test.${collection}`, {
              find: `test.${collection}`,
              query: { a: 1 }
            })

            cursor.next(() => {
              expect(tracer.scopeManager().active()).to.be.null
              done()
            })
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

            const cursor = server.cursor(`test.${collection}`, {
              find: `test.${collection}`,
              query: 'invalid'
            })

            cursor.next(err => {
              error = err
            })
          })
        })
      })

      describe('with configuration', () => {
        let config

        beforeEach(done => {
          config = {
            service: 'custom'
          }

          agent.load(plugin, 'mongodb-core', config)
            .then(() => {
              mongo = require(`./versions/mongodb-core@${version}`).get()

              server = new mongo.Server({
                host: 'localhost',
                port: 27017,
                reconnect: false
              })

              server.on('connect', () => done())
              server.on('error', done)

              server.connect()
            })
            .catch(done)
        })

        it('should be configured with the correct values', done => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', 'custom')
            })
            .then(done)
            .catch(done)

          server.insert(`test.${collection}`, [{ a: 1 }], () => {})
        })
      })
    })
  })
})
