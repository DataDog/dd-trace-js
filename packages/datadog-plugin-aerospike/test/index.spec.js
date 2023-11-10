'use strict'

const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
// const { expectedSchema, rawExpectedSchema } = require('./naming')

const withTopologies = fn => {
  withVersions('mongodb-core', ['mongodb-core', 'mongodb'], '<4', (version, moduleName) => {
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
  let client
  let aerospike
  let config
  let tracer
  let ns
  let key

  describe('aerospike', () => {
    withVersions('aerospike', 'aerospike', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
        aerospike = require(`../../../versions/aerospike@${version}`).get()
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load('aerospike')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          ns = 'test'
          config = {
            hosts: '127.0.0.1:3000',
            port: '3000'
          }

          client = aerospike.client(config)
          key = new aerospike.Key(ns, 'demo', 'key')
        })

        afterEach(() => {
          // if (!client.isClosed()) {
          //   client.close()
          // }
          client.close()
        })

        describe('client', () => {
          it('should instrument put', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                const resource = `aerospike.put`

                expect(span).to.have.property('name', 'aerospike.query')
                expect(span).to.have.property('service', 'test-aerospike')
                expect(span).to.have.property('resource', resource)
                expect(span).to.have.property('type', 'aerospike')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('db.name', ns)
                expect(span.meta).to.have.property('out.host', config.hosts)
                expect(span.meta).to.have.property('out.port', config.port)
                expect(span.meta).to.have.property('component', 'aerospike')
              })
              .then(done)
              .catch(done)

            client.connect(() => {
              client.put(key, { i: 123 }, () => {
                // client.close(() => {})
              })
            })
          })

          it('should instrument connect', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                const resource = `aerospike.connect`
                expect(span).to.have.property('name', 'aerospike.query')
                expect(span).to.have.property('service', 'test-aerospike')
                expect(span).to.have.property('resource', resource)
                expect(span).to.have.property('type', 'aerospike')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('out.host', config.hosts)
                expect(span.meta).to.have.property('out.port', config.port)
                expect(span.meta).to.have.property('component', 'aerospike')
              })
              .then(done)
              .catch(done)

            client.connect(() => {
              // client.close(() => {})
            })
          })

          it('should instrument get', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                const resource = `aerospike.get`
                expect(span).to.have.property('name', 'aerospike.query')
                expect(span).to.have.property('service', 'test-aerospike')
                expect(span).to.have.property('resource', resource)
                expect(span).to.have.property('type', 'aerospike')
                expect(span.meta).to.have.property('db.name', ns)
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('out.host', config.hosts)
                expect(span.meta).to.have.property('out.port', config.port)
                expect(span.meta).to.have.property('component', 'aerospike')
              })
              .then(done)
              .catch(done)

            client.connect(() => {
              client.get(key, () => {
                // client.close(() => {})
              })
            })
          })

          it('should instrument operate', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                const resource = `aerospike.operate`
                expect(span).to.have.property('name', 'aerospike.query')
                expect(span).to.have.property('service', 'test-aerospike')
                expect(span).to.have.property('resource', resource)
                expect(span).to.have.property('type', 'aerospike')
                expect(span.meta).to.have.property('db.name', ns)
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('out.host', config.hosts)
                expect(span.meta).to.have.property('out.port', config.port)
                expect(span.meta).to.have.property('component', 'aerospike')
              })
              .then(done)
              .catch(done)

            client.connect(() => {
              client.put(key, { i: 123 }, () => {
                const ops = [
                  aerospike.operations.incr('i', 1),
                  aerospike.operations.read('i')
                ]
                client.operate(key, ops, () => {
                  // client.close(() => {})
                })
              })
            })
          })

          it('should instrument query', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                const resource = `aerospike.query`
                expect(span).to.have.property('name', 'aerospike.query')
                expect(span).to.have.property('service', 'test-aerospike')
                expect(span).to.have.property('resource', resource)
                expect(span).to.have.property('type', 'aerospike')
                expect(span.meta).to.have.property('db.name', ns)
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('out.host', config.hosts)
                expect(span.meta).to.have.property('out.port', config.port)
                expect(span.meta).to.have.property('component', 'aerospike')
              })
              .then(done)
              .catch(done)

            client.connect(() => {
              const index = {
                ns: ns,
                set: 'demo',
                bin: 'tags',
                index: 'tags_idx',
                type: aerospike.indexType.LIST,
                datatype: aerospike.indexDataType.STRING
              }
              client.createIndex(index, (error, job) => {
                const exp = aerospike.exp
                const query = client.query('test', 'demo')
                const queryPolicy = { filterExpression: exp.keyExist('uniqueExpKey') }
                query.select('id', 'tags')
                query.where(aerospike.filter.contains('tags', 'green', aerospike.indexType.LIST))
                const stream = query.foreach(queryPolicy)
                stream.on('end', () => {
                  // client.close()
                })
              })
            })
          })

          it('should run the callback in the parent context', done => {
            const obj = {}
            client.connect(() => {
              // console.log(77)
              tracer.scope().activate(obj, () => {
                client.put(key, { i: 123 }, () => {
                  expect(tracer.scope().active()).to.equal(obj)
                  done()
                })
              })
            })
          })

          it('should handle errors', done => {
            let error

            agent
              .use(traces => {
                expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
                expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
                expect(traces[0][0].meta).to.have.property('component', 'aerospike')
              })
              .then(done)
              .catch(done)

            client.connect(() => {
              client.put(key, { i: 'not_a_number' }, () => {
                const ops = [
                  aerospike.operations.incr('i', 1), // Incrementing a bin that is not of type numeric
                  aerospike.operations.read('i')
                ]

                client.operate(key, ops, (err) => {
                  error = err
                  // client.close(() => {})
                  // console.log(88, err) // err should not be null if the operation fails
                })
              })
            })

            // server.insert('', [{ a: 1 }], (err) => {
            //   error = err
            //   server.destroy()
            // })
          })

          // it('should not swallow missing callback errors', done => {
          //   try {
          //     server.insert(`test.${collection}`, [{ a: 1 }], {})
          //   } catch (e) {
          //     done()
          //   }
          // })
        })

        //   describe('cursor', () => {
        //     it('should do automatic instrumentation', done => {
        //       let cursor

        //       Promise.all([
        //         agent
        //           .use(traces => {
        //             expect(traces[0][0].resource).to.equal(`find test.${collection}`)
        //           }),
        //         agent
        //           .use(traces => {
        //             expect(traces[0][0].resource).to.equal(`getMore test.${collection}`)
        //           }),
        //         agent
        //           .use(traces => {
        //             expect(traces[0][0].resource).to.equal(`killCursors test.${collection}`)
        //           })
        //       ])
        //         .then(() => done())
        //         .catch(done)

        //       server.insert(`test.${collection}`, [{ a: 1 }, { a: 2 }, { a: 3 }], {}, () => {
        //         cursor = server.cursor(`test.${collection}`, {
        //           find: `test.${collection}`,
        //           query: {},
        //           batchSize: 1
        //         }, { batchSize: 1 })

        //         next(cursor, () => next(cursor, () => cursor.kill(() => {})))
        //       })
        //     })

        //     it('should sanitize the query as the resource', done => {
        //       agent
        //         .use(traces => {
        //           const span = traces[0][0]
        //           const resource = `find test.${collection}`
        //           const query = `{"foo":1,"bar":{"baz":[1,2,3]}}`

        //           expect(span).to.have.property('resource', resource)
        //           expect(span.meta).to.have.property('mongodb.query', query)
        //         })
        //         .then(done)
        //         .catch(done)

        //       const cursor = server.cursor(`test.${collection}`, {
        //         find: `test.${collection}`,
        //         query: {
        //           foo: 1,
        //           bar: {
        //             baz: [1, 2, 3]
        //           }
        //         }
        //       })

        //       next(cursor)
        //     })

        //     it('should run the callback in the parent context', done => {
        //       const cursor = server.cursor(`test.${collection}`, {
        //         find: `test.${collection}`,
        //         query: { a: 1 }
        //       })

        //       next(cursor, () => {
        //         expect(tracer.scope().active()).to.be.null
        //         done()
        //       })
        //     })

        //     it('should handle errors', done => {
        //       let error

        //       agent
        //         .use(traces => {
        //           expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
        //           expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
        //           expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
        //           expect(traces[0][0].meta).to.have.property('component', 'mongodb')
        //         })
        //         .then(done)
        //         .catch(done)

        //       const cursor = server.cursor(`test.${collection}`, {
        //         find: `test.${collection}`,
        //         query: 'invalid'
        //       })

        //       next(cursor, err => {
        //         error = err
        //       })
        //     })

        //     withNamingSchema(
        //       () => server.insert(`test.${collection}`, [{ a: 1 }], () => {}),
        //       rawExpectedSchema.outbound
        //     )
        //   })
        // })

        // describe('with configuration', () => {
        //   before(() => {
        //     return agent.load('mongodb-core', { service: 'custom' })
        //   })

        //   after(() => {
        //     return agent.close({ ritmReset: false })
        //   })

        //   beforeEach(done => {
        //     const Server = getServer()

        //     server = new Server({
        //       host: 'localhost',
        //       port: 27017,
        //       reconnect: false
        //     })

        //     server.on('connect', () => done())
        //     server.on('error', done)

        //     server.connect()
        //   })

        //   it('should be configured with the correct values', done => {
        //     agent
        //       .use(traces => {
        //         expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
        //         expect(traces[0][0]).to.have.property('service', 'custom')
        //       })
        //       .then(done)
        //       .catch(done)

        //     server.insert(`test.${collection}`, [{ a: 1 }], () => {})
        //   })

      //   withNamingSchema(
      //     () => server.insert(`test.${collection}`, [{ a: 1 }], () => {}),
      //     {
      //       v0: {
      //         opName: 'mongodb.query',
      //         serviceName: 'custom'
      //       },
      //       v1: {
      //         opName: 'mongodb.query',
      //         serviceName: 'custom'
      //       }
      //     }
      //   )
      })
    })
  })
})
