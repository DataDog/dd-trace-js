'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const semver = require('semver')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { expectedSchema, rawExpectedSchema } = require('./naming')
const { NODE_MAJOR } = require('../../../version')

describe('Plugin', () => {
  let aerospike
  let config
  let tracer
  let ns
  let set
  let userKey
  let key
  let keyString

  describe('aerospike', () => {
    withVersions('aerospike', 'aerospike', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
        aerospike = require(`../../../versions/aerospike@${version}`).get()
      })

      beforeEach(() => {
        ns = 'test'
        set = 'demo'
        userKey = 'key'

        config = {
          hosts: '127.0.0.1:3000',
          port: '3000'
        }
        key = new aerospike.Key(ns, set, userKey)
        keyString = `${ns}:${set}:${userKey}`
      })

      after(() => {
        return agent.close({ ritmReset: false })
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load('aerospike')
        })

        after(() => {
          aerospike.releaseEventLoop()
        })

        describe('client', () => {
          withPeerService(
            () => tracer,
            'aerospike',
            () => aerospike.connect(config).then(client => {
              return client.put(key, { i: 123 })
                .then(() => client.close(false))
            }),
            'test',
            'aerospike.namespace'
          )
          it('should instrument put', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', expectedSchema.command.opName)
                expect(span).to.have.property('service', expectedSchema.command.serviceName)
                expect(span).to.have.property('resource', `Put`)
                expect(span).to.have.property('type', 'aerospike')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('aerospike.key', keyString)
                expect(span.meta).to.have.property('aerospike.namespace', ns)
                expect(span.meta).to.have.property('aerospike.setname', set)
                expect(span.meta).to.have.property('aerospike.userkey', userKey)
                expect(span.meta).to.have.property('component', 'aerospike')
              })
              .then(done)
              .catch(done)

            aerospike.connect(config).then(client => {
              return client.put(key, { i: 123 })
                .then(() => {
                  client.close(false)
                })
            })
          })

          it('should instrument connect', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', expectedSchema.command.opName)
                expect(span).to.have.property('service', expectedSchema.command.serviceName)
                expect(span).to.have.property('resource', `Connect`)
                expect(span).to.have.property('type', 'aerospike')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('component', 'aerospike')
              })
              .then(done)
              .catch(done)

            aerospike.connect(config).then(client => { client.close(false) })
          })

          it('should instrument get', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', expectedSchema.command.opName)
                expect(span).to.have.property('service', expectedSchema.command.serviceName)
                expect(span).to.have.property('resource', `Get`)
                expect(span).to.have.property('type', 'aerospike')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('aerospike.key', keyString)
                expect(span.meta).to.have.property('aerospike.namespace', ns)
                expect(span.meta).to.have.property('aerospike.setname', set)
                expect(span.meta).to.have.property('aerospike.userkey', userKey)
                expect(span.meta).to.have.property('component', 'aerospike')
              })
              .then(done)
              .catch(done)

            aerospike.connect(config).then(client => {
              return client.get(key)
                .then(() => client.close(false))
            })
          })

          it('should instrument operate', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', expectedSchema.command.opName)
                expect(span).to.have.property('service', expectedSchema.command.serviceName)
                expect(span).to.have.property('resource', `Operate`)
                expect(span).to.have.property('type', 'aerospike')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('aerospike.key', keyString)
                expect(span.meta).to.have.property('aerospike.namespace', ns)
                expect(span.meta).to.have.property('aerospike.setname', set)
                expect(span.meta).to.have.property('aerospike.userkey', userKey)
                expect(span.meta).to.have.property('component', 'aerospike')
              })
              .then(done)
              .catch(done)

            aerospike.connect(config).then(client => {
              return client.put(key, { i: 123 })
                .then(() => {
                  const ops = [
                    aerospike.operations.incr('i', 1),
                    aerospike.operations.read('i')
                  ]
                  return client.operate(key, ops)
                })
                .then(() => client.close(false))
            })
          })

          it('should instrument createIndex', done => {
            agent
              .use(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', expectedSchema.command.opName)
                expect(span).to.have.property('service', expectedSchema.command.serviceName)
                expect(span).to.have.property('resource', `IndexCreate`)
                expect(span).to.have.property('type', 'aerospike')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('aerospike.namespace', ns)
                expect(span.meta).to.have.property('aerospike.setname', 'demo')
                expect(span.meta).to.have.property('aerospike.bin', 'tags')
                expect(span.meta).to.have.property('aerospike.index', 'tags_idx')
                expect(span.meta).to.have.property('component', 'aerospike')
              })
              .then(done)
              .catch(done)

            aerospike.connect(config).then(client => {
              const index = {
                ns: ns,
                set: 'demo',
                bin: 'tags',
                index: 'tags_idx',
                type: aerospike.indexType.LIST,
                datatype: aerospike.indexDataType.STRING
              }
              return client.createIndex(index)
                .then(() => client.close(false))
            })
          })

          // skip query tests for node 16 and aerospike 4 because of an aerospike error that occurs when using query:
          // AerospikeError: Sometimes our doc, or our customers' wishes, get ahead of us.
          // We may have processed something that the server is not ready for (unsupported feature).
          // this test works on node 14, so it is not a problem with the test but most likely a problem with the package
          // version and aerospike server version mismatch which is really hard to pin down, since aerospike doesn't
          // provide info on package version's compatibility with each server version
          if (!(NODE_MAJOR === 16 && semver.intersects(version, '^4')) || !semver.intersects(version, '^3')) {
            it('should instrument query', done => {
              agent
                .use(traces => {
                  const span = traces[0][0]
                  expect(span).to.have.property('name', expectedSchema.command.opName)
                  expect(span).to.have.property('service', expectedSchema.command.serviceName)
                  expect(span).to.have.property('resource', `Query`)
                  expect(span).to.have.property('type', 'aerospike')
                  expect(span.meta).to.have.property('span.kind', 'client')
                  expect(span.meta).to.have.property('aerospike.namespace', ns)
                  expect(span.meta).to.have.property('aerospike.setname', set)
                  expect(span.meta).to.have.property('component', 'aerospike')
                })
                .then(done)
                .catch(done)

              aerospike.connect(config).then(client => {
                const index = {
                  ns: ns,
                  set: 'demo',
                  bin: 'tags',
                  index: 'tags_idx',
                  datatype: aerospike.indexDataType.STRING
                }
                client.createIndex(index, (error, job) => {
                  job.waitUntilDone((waitError) => {
                    const query = client.query(ns, 'demo')
                    const queryPolicy = {
                      totalTimeout: 10000
                    }
                    query.select('id', 'tags')
                    query.where(aerospike.filter.contains('tags', 'green', aerospike.indexType.LIST))
                    const stream = query.foreach(queryPolicy)
                    stream.on('end', () => { client.close(false) })
                  })
                })
              })
            })
          }
          it('should run the callback in the parent context', done => {
            const obj = {}
            aerospike.connect(config).then(client => {
              tracer.scope().activate(obj, () => {
                client.put(key, { i: 123 }, () => {
                  expect(tracer.scope().active()).to.equal(obj)
                  client.close(false)
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

            aerospike.connect(config)
              .then(client => {
                return client.put(key, { i: 'not_a_number' })
                  .then(() => {
                    const ops = [
                      aerospike.operations.incr('i', 1),
                      aerospike.operations.read('i')
                    ]

                    return client.operate(key, ops)
                  })
                  .then(() => client.close(false))
              })
              .catch(err => {
                error = err
              })
          })
          withNamingSchema(
            () => aerospike.connect(config).then(client => {
              return client.put(key, { i: 123 })
                .then(() => client.close(false))
            }),
            rawExpectedSchema.command
          )
        })
      })

      // describe('with configuration', () => {
      //   before(() => {
      //     return agent.load('aerospike', { service: 'custom' })
      //   })

      //   it('should be configured with the correct values', done => {
      //     agent
      //       .use(traces => {
      //         expect(traces[0][0]).to.have.property('name', expectedSchema.command.opName)
      //         expect(traces[0][0]).to.have.property('service', 'custom')
      //       })
      //       .then(done)
      //       .catch(done)

      //     aerospike.connect(config).then(client => {
      //       return client.put(key, { i: 123 })
      //         .then(() => client.close())
      //     })
      //   })

      //   withNamingSchema(
      //     () => aerospike.connect(config).then(client => {
      //       return client.put(key, { i: 123 })
      //         .then(() => client.close())
      //     }),
      //     {
      //       v0: {
      //         opName: 'aerospike.command',
      //         serviceName: 'custom'
      //       },
      //       v1: {
      //         opName: 'aerospike.command',
      //         serviceName: 'custom'
      //       }
      //     }
      //   )
      // })
    })
  })
})
