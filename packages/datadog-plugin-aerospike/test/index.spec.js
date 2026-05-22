'use strict'

const assert = require('node:assert/strict')

const { after, before, beforeEach, describe, it } = require('mocha')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema, rawExpectedSchema } = require('./naming')

describe('Plugin', () => {
  let aerospike
  let config
  let tracer
  let ns
  let set
  let userKey
  let key
  let keyString
  let indexName
  let binName
  let indexCounter = 0

  describe('aerospike', function () {
    this.timeout(8000)

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
            { addr: process.env.AEROSPIKE_HOST_ADDRESS ? process.env.AEROSPIKE_HOST_ADDRESS : '127.0.0.1', port: 3000 },
          ],
        }
        key = new aerospike.Key(ns, set, userKey)
        keyString = `${ns}:${set}:${userKey}`
        const id = ++indexCounter
        binName = `b${id}`
        indexName = `i${id}`
      })

      after(() => {
        return agent.close()
      })

      describe('without configuration', () => {
        before(function () {
          this.timeout(10_000)
          return agent.load('aerospike')
        })

        after(() => {
          aerospike?.releaseEventLoop()
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
                  component: 'aerospike',
                },
              })
              .then(done)
              .catch(done)

            aerospike.connect(config).then(client => {
              return client.put(key, { i: 123 })
                .then(() => {
                  client.close(false)
                })
            }).catch(done)
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
                  component: 'aerospike',
                },
              })
              .then(done)
              .catch(done)

            aerospike.connect(config).then(client => { client.close(false) }).catch(done)
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
                  component: 'aerospike',
                },
              })
              .then(done)
              .catch(done)

            aerospike.connect(config).then(client => {
              return client.get(key)
                .then(() => client.close(false))
            }).catch(done)
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
                  component: 'aerospike',
                },
              })
              .then(done)
              .catch(done)

            aerospike.connect(config).then(client => {
              return client.put(key, { i: 123 })
                .then(() => {
                  const ops = [
                    aerospike.operations.incr('i', 1),
                    aerospike.operations.read('i'),
                  ]
                  return client.operate(key, ops)
                })
                .then(() => client.close(false))
            }).catch(done)
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
                  'aerospike.bin': binName,
                  'aerospike.index': indexName,
                  component: 'aerospike',
                },
              })
              .then(done)
              .catch(done)

            aerospike.connect(config).then(client => {
              const index = {
                ns,
                set: 'demo',
                bin: binName,
                index: indexName,
                type: aerospike.indexType.LIST,
                datatype: aerospike.indexDataType.STRING,
              }
              return client.createIndex(index)
                .then(() => client.close(false))
            }).catch(done)
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
                  component: 'aerospike',
                },
              })
              .then(done)
              .catch(done)

            aerospike.connect(config).then(async client => {
              await client.put(key, { [binName]: ['green', 'blue'] })
              const index = {
                ns,
                set: 'demo',
                bin: binName,
                index: indexName,
                type: aerospike.indexType.LIST,
                datatype: aerospike.indexDataType.STRING,
              }
              client.createIndex(index, (error, job) => {
                if (!job) return done(error ?? new Error('no job returned by createIndex'))
                job.waitUntilDone((waitError) => {
                  if (waitError) return done(waitError)
                  // waitUntilDone signals the index is built, but the server
                  // query thread may need a moment to pick it up. Retry with
                  // a short delay until the query succeeds or retries run out.
                  let retries = 0
                  const runQuery = () => {
                    const q = client.query(ns, 'demo')
                    q.select('id', binName)
                    q.where(aerospike.filter.contains(binName, 'green', aerospike.indexType.LIST))
                    const stream = q.foreach({ totalTimeout: 10000 })
                    stream.on('error', (err) => {
                      if (retries++ < 5) setTimeout(runQuery, 500)
                      else done(err)
                    })
                    stream.on('end', () => { client.close(false) })
                  }
                  runQuery()
                })
              })
            }).catch(done)
          })

          it('should run the callback in the parent context', done => {
            const span = tracer.startSpan('test')
            aerospike.connect(config).then(client => {
              tracer.scope().activate(span, () => {
                client.put(key, { i: 123 }, () => {
                  assert.strictEqual(tracer.scope().active(), span)
                  client.close(false)
                  done()
                })
              })
            }).catch(done)
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
                    component: 'aerospike',
                  },
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
                      aerospike.operations.read('i'),
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
        before(function () {
          this.timeout(10_000)
          return agent.load('aerospike', { service: 'custom' })
        })

        after(() => {
          aerospike?.releaseEventLoop()
        })

        it('should be configured with the correct values', done => {
          agent
            .assertFirstTraceSpan({
              name: expectedSchema.command.opName,
              service: 'custom',
            })
            .then(done)
            .catch(done)

          aerospike.connect(config).then(client => {
            return client.put(key, { i: 123 })
              .then(() => client.close(false))
          }).catch(done)
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
              serviceName: 'custom',
            },
            v1: {
              opName: 'aerospike.command',
              serviceName: 'custom',
            },
          }
        )
      })
    })
  })
})
