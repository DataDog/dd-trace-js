'use strict'

const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

const withTopologies = fn => {
  withVersions(plugin, ['mongodb-core', 'mongodb'], '<4', (version, moduleName) => {
    describe('using the server topology', () => {
      fn(() => {
        const { CoreServer, Server } = require(`../../../versions/${moduleName}@${version}`).get()

        return CoreServer || Server
      })
    })

    // TODO: use semver.subset when we can update semver
    if (moduleName === 'mongodb-core' && !semver.intersects(version, '<3.2')) {
      describe('using the unified topology', () => {
        fn(() => require(`../../../versions/${moduleName}@${version}`).get().Topology)
      })
    }
  })
}

describe('Plugin', () => {
  let server
  let id
  let tracer
  let collection

  describe('mongodb-core (core)', () => {
    withTopologies(getServer => {
      const next = (cursor, cb = () => {}) => {
        return cursor._next
          ? cursor._next(cb)
          : cursor.next(cb)
      }

      beforeEach(() => {
        id = require('../../dd-trace/src/id')
        tracer = require('../../dd-trace')

        collection = id().toString()
      })

      afterEach(() => {
        server.destroy()
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load('mongodb-core')
        })

        after(() => {
          return agent.close()
        })

        beforeEach(done => {
          const Server = getServer()

          server = new Server({
            host: 'localhost',
            port: 27017,
            reconnect: false
          })

          server.on('connect', () => done())
          server.on('error', done)

          server.connect()
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
                expect(span.meta).to.have.property('span.kind', 'client')
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

          it('should sanitize the query', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                const query = '{"foo":"?","bar":{"baz":"?"}}'
                const resource = `find test.${collection} ${query}`

                expect(span).to.have.property('resource', resource)
                expect(span.meta).to.have.property('mongodb.query', query)
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

          it('should sanitize BSON as values and not as objects', done => {
            const BSON = require(`../../../versions/bson@4.0.0`).get()

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
                _id: new BSON.ObjectID('123456781234567812345678')
              }
            }, () => {})
          })

          it('should skip functions when sanitizing', done => {
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
                _id: '1234',
                foo: () => {}
              }
            }, () => {})
          })

          it('should run the callback in the parent context', done => {
            if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

            server.insert(`test.${collection}`, [{ a: 1 }], {}, () => {
              expect(tracer.scope().active()).to.be.null
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

          it('should not swallow missing callback errors', done => {
            try {
              server.insert(`test.${collection}`, [{ a: 1 }], {})
            } catch (e) {
              done()
            }
          })
        })

        describe('cursor', () => {
          it('should do automatic instrumentation', done => {
            let cursor

            Promise.all([
              agent
                .use(traces => {
                  expect(traces[0][0].resource).to.equal(`find test.${collection} {}`)
                }),
              agent
                .use(traces => {
                  expect(traces[0][0].resource).to.equal(`getMore test.${collection}`)
                }),
              agent
                .use(traces => {
                  expect(traces[0][0].resource).to.equal(`killCursors test.${collection}`)
                })
            ])
              .then(() => done())
              .catch(done)

            server.insert(`test.${collection}`, [{ a: 1 }, { a: 2 }, { a: 3 }], {}, () => {
              cursor = server.cursor(`test.${collection}`, {
                find: `test.${collection}`,
                query: {},
                batchSize: 1
              }, { batchSize: 1 })

              next(cursor, () => next(cursor, () => cursor.kill(() => {})))
            })
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

            next(cursor)
          })

          it('should run the callback in the parent context', done => {
            if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

            const cursor = server.cursor(`test.${collection}`, {
              find: `test.${collection}`,
              query: { a: 1 }
            })

            next(cursor, () => {
              expect(tracer.scope().active()).to.be.null
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

            next(cursor, err => {
              error = err
            })
          })
        })
      })

      describe('with configuration', () => {
        before(() => {
          return agent.load('mongodb-core', { service: 'custom' })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(done => {
          const Server = getServer()

          server = new Server({
            host: 'localhost',
            port: 27017,
            reconnect: false
          })

          server.on('connect', () => done())
          server.on('error', done)

          server.connect()
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
