'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, before, after } = require('mocha')

const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { expectedSchema, rawExpectedSchema } = require('./naming')
const { assertObjectContains } = require('../../../integration-tests/helpers')

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
          hosts: [
            { addr: process.env.AEROSPIKE_HOST_ADDRESS ? process.env.AEROSPIKE_HOST_ADDRESS : '127.0.0.1', port: 3000 }
          ]
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
            async () => {
              const client = await aerospike.connect(config)
              await client.put(key, { i: 123 })
              return client.close(false)
            },
            'test',
            'aerospike.namespace'
          )

          it('should instrument put', done => {
            agent
              .assertFirstTraceSpan({
                name: expectedSchema.command.opName,
                service: expectedSchema.command.serviceName,
                resource: 'Put',
                type: 'aerospike',
                meta: {
                  'span.kind': 'client',
                  'aerospike.key': keyString,
                  'aerospike.namespace': ns,
                  'aerospike.setname': set,
                  'aerospike.userkey': userKey,
                  component: 'aerospike'
                }
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
              .assertFirstTraceSpan({
                name: expectedSchema.command.opName,
                service: expectedSchema.command.serviceName,
                resource: 'Connect',
                type: 'aerospike',
                meta: {
                  'span.kind': 'client',
                  component: 'aerospike'
                }
              })
              .then(done)
              .catch(done)

            aerospike.connect(config).then(client => { client.close(false) })
          })

          it('should instrument get', done => {
            agent
              .assertFirstTraceSpan({
                name: expectedSchema.command.opName,
                service: expectedSchema.command.serviceName,
                resource: 'Get',
                type: 'aerospike',
                meta: {
                  'span.kind': 'client',
                  'aerospike.key': keyString,
                  'aerospike.namespace': ns,
                  'aerospike.setname': set,
                  'aerospike.userkey': userKey,
                  component: 'aerospike'
                }
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
              .assertFirstTraceSpan({
                name: expectedSchema.command.opName,
                service: expectedSchema.command.serviceName,
                resource: 'Operate',
                type: 'aerospike',
                meta: {
                  'span.kind': 'client',
                  'aerospike.key': keyString,
                  'aerospike.namespace': ns,
                  'aerospike.setname': set,
                  'aerospike.userkey': userKey,
                  component: 'aerospike'
                }
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
              .assertFirstTraceSpan({
                name: expectedSchema.command.opName,
                service: expectedSchema.command.serviceName,
                resource: 'IndexCreate',
                type: 'aerospike',
                meta: {
                  'span.kind': 'client',
                  'aerospike.namespace': ns,
                  'aerospike.setname': 'demo',
                  'aerospike.bin': 'tags',
                  'aerospike.index': 'tags_idx',
                  component: 'aerospike'
                }
              })
              .then(done)
              .catch(done)

            aerospike.connect(config).then(client => {
              const index = {
                ns,
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

          it('should instrument query', done => {
            agent
              .assertFirstTraceSpan({
                name: expectedSchema.command.opName,
                service: expectedSchema.command.serviceName,
                resource: 'Query',
                type: 'aerospike',
                meta: {
                  'span.kind': 'client',
                  'aerospike.namespace': ns,
                  'aerospike.setname': set,
                  component: 'aerospike'
                }
              })
              .then(done)
              .catch(done)

            aerospike.connect(config).then(client => {
              const index = {
                ns,
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
              .assertFirstTraceSpan((trace) => {
                assertObjectContains(trace, {
                  meta: {
                    [ERROR_TYPE]: error.name,
                    [ERROR_MESSAGE]: error.message,
                    [ERROR_STACK]: error.stack,
                    component: 'aerospike'
                  }
                })
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
            async () => {
              const client = await aerospike.connect(config)
              await client.put(key, { i: 123 })
              return client.close(false)
            },
            rawExpectedSchema.command
          )
        })
      })

      describe('with configuration', () => {
        before(() => {
          return agent.load('aerospike', { service: 'custom' })
        })

        after(() => {
          aerospike.releaseEventLoop()
        })

        it('should be configured with the correct values', done => {
          agent
            .assertFirstTraceSpan({
              name: expectedSchema.command.opName,
              service: 'custom'
            })
            .then(done)
            .catch(done)

          aerospike.connect(config).then(client => {
            return client.put(key, { i: 123 })
              .then(() => client.close(false))
          })
        })

        withNamingSchema(
          async () => {
            const client = await aerospike.connect(config)
            await client.put(key, { i: 123 })
            return client.close(false)
          },
          {
            v0: {
              opName: 'aerospike.command',
              serviceName: 'custom'
            },
            v1: {
              opName: 'aerospike.command',
              serviceName: 'custom'
            }
          }
        )
      })
    })
  })
})
