'use strict'

const assert = require('node:assert/strict')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const ddpv = require('mocha/package.json').version
const sinon = require('sinon')
const semver = require('semver')

const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const MongodbCorePlugin = require('../../datadog-plugin-mongodb-core/src/index')
const { expectedSchema, rawExpectedSchema } = require('./naming')

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
  let id
  let tracer
  let collection
  let startSpy

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
        // Newer versions of mongodb-core use the close method instead of destroy
        if ('close' in server) {
          server.close()
        } else {
          server.destroy()
        }
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load('mongodb-core')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(done => {
          const Server = getServer()

          server = new Server({
            host: '127.0.0.1',
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
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                const resource = `insert test.${collection}`

                assert.strictEqual(span.name, expectedSchema.outbound.opName)
                assert.strictEqual(span.service, expectedSchema.outbound.serviceName)
                assert.strictEqual(span.resource, resource)
                assert.strictEqual(span.type, 'mongodb')
                assert.strictEqual(span.meta['span.kind'], 'client')
                assert.strictEqual(span.meta['db.name'], `test.${collection}`)
                assert.strictEqual(span.meta['out.host'], '127.0.0.1')
                assert.strictEqual(span.meta.component, 'mongodb')
                assert.strictEqual(span.meta['_dd.integration'], 'mongodb')
              })
              .then(done)
              .catch(done)

            server.insert(`test.${collection}`, [{ a: 1 }], {}, () => {})
          })

          it('should use the correct resource name for arbitrary commands', done => {
            agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                const resource = `planCacheListPlans test.${collection}`

                assert.strictEqual(span.resource, resource)
              })
              .then(done)
              .catch(done)

            server.command(`test.${collection}`, {
              planCacheListPlans: `test.${collection}`,
              query: {}
            }, () => {})
          })

          it('should sanitize buffers as values and not as objects', done => {
            agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                const resource = `find test.${collection}`
                const query = '{"_id":"?"}'

                assert.strictEqual(span.resource, resource)
                assert.strictEqual(span.meta['mongodb.query'], query)
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

          it('should serialize BigInt without erroring', done => {
            agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                const resource = `find test.${collection}`
                const query = '{"_id":"9999999999999999999999"}'

                assert.strictEqual(span.resource, resource)
                assert.strictEqual(span.meta['mongodb.query'], query)
              })
              .then(done)
              .catch(done)

            try {
              server.command(`test.${collection}`, {
                find: `test.${collection}`,
                query: {
                  _id: 9999999999999999999999n
                }
              }, () => {})
            } catch (err) {
              // It appears that most versions of MongodDB are happy to use a BigInt instance.
              // For example, 2.0.0, 3.2.0, 3.1.10, etc.
              // However, version 3.1.9 throws a synchronous error that it wants a Decimal128 instead.
              if (err.message.includes('Decimal128')) {
                // eslint-disable-next-line no-console
                console.log('This version of mongodb-core does not accept BigInt instances')
                return done()
              }
              done(err)
            }
          })

          it('should stringify BSON objects', done => {
            const BSON = require('../../../versions/bson@4.0.0').get()
            const id = '123456781234567812345678'

            agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                const resource = `find test.${collection}`
                const query = `{"_id":"${id}"}`

                assert.strictEqual(span.resource, resource)
                assert.strictEqual(span.meta['mongodb.query'], query)
              })
              .then(done)
              .catch(done)

            server.command(`test.${collection}`, {
              find: `test.${collection}`,
              query: {
                _id: new BSON.ObjectID(id)
              }
            }, () => {})
          })

          it('should skip functions when sanitizing', done => {
            agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                const resource = `find test.${collection}`
                const query = '{"_id":"1234"}'

                assert.strictEqual(span.resource, resource)
                assert.strictEqual(span.meta['mongodb.query'], query)
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
            server.insert(`test.${collection}`, [{ a: 1 }], {}, () => {
              assert.strictEqual(tracer.scope().active(), null)
              done()
            })
          })

          it('should handle errors', done => {
            let error

            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].meta[ERROR_TYPE], error.name)
                assert.strictEqual(traces[0][0].meta[ERROR_MESSAGE], error.message)
                assert.strictEqual(traces[0][0].meta[ERROR_STACK], error.stack)
                assert.strictEqual(traces[0][0].meta.component, 'mongodb')
              })
              .then(done)
              .catch(done)

            server.insert('', [{ a: 1 }], (err) => {
              error = err
              if ('close' in server) {
                server.close()
              } else {
                server.destroy()
              }
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
                .assertSomeTraces(traces => {
                  assert.strictEqual(traces[0][0].resource, `find test.${collection}`)
                }),
              agent
                .assertSomeTraces(traces => {
                  assert.strictEqual(traces[0][0].resource, `getMore test.${collection}`)
                }),
              agent
                .assertSomeTraces(traces => {
                  assert.strictEqual(traces[0][0].resource, `killCursors test.${collection}`)
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
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                const resource = `find test.${collection}`
                const query = '{"foo":1,"bar":{"baz":[1,2,3]}}'

                assert.strictEqual(span.resource, resource)
                assert.strictEqual(span.meta['mongodb.query'], query)
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
            const cursor = server.cursor(`test.${collection}`, {
              find: `test.${collection}`,
              query: { a: 1 }
            })

            next(cursor, () => {
              assert.strictEqual(tracer.scope().active(), null)
              done()
            })
          })

          it('should handle errors', done => {
            let error

            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].meta[ERROR_TYPE], error.name)
                assert.strictEqual(traces[0][0].meta[ERROR_MESSAGE], error.message)
                assert.strictEqual(traces[0][0].meta[ERROR_STACK], error.stack)
                assert.strictEqual(traces[0][0].meta.component, 'mongodb')
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

          withNamingSchema(
            () => server.insert(`test.${collection}`, [{ a: 1 }], () => {}),
            rawExpectedSchema.outbound
          )
        })
      })

      describe('with configuration', () => {
        before(() => {
          return agent.load('mongodb-core', { service: 'custom' })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(done => {
          const Server = getServer()

          server = new Server({
            host: '127.0.0.1',
            port: 27017,
            reconnect: false
          })

          server.on('connect', () => done())
          server.on('error', done)

          server.connect()
        })

        it('should be configured with the correct values', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
              assert.strictEqual(traces[0][0].service, 'custom')
            })
            .then(done)
            .catch(done)

          server.insert(`test.${collection}`, [{ a: 1 }], () => {})
        })

        withNamingSchema(
          () => server.insert(`test.${collection}`, [{ a: 1 }], () => {}),
          {
            v0: {
              opName: 'mongodb.query',
              serviceName: 'custom'
            },
            v1: {
              opName: 'mongodb.query',
              serviceName: 'custom'
            }
          }
        )
      })

      describe('with dbmPropagationMode disabled by default', () => {
        before(() => {
          return agent.load('mongodb-core')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(done => {
          const Server = getServer()

          server = new Server({
            host: '127.0.0.1',
            port: 27017,
            reconnect: false
          })

          server.on('connect', () => done())
          server.on('error', done)

          server.connect()

          startSpy = sinon.spy(MongodbCorePlugin.prototype, 'start')
        })

        afterEach(() => {
          startSpy?.restore()
        })

        it('DBM propagation should not inject comment', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(startSpy.called, true)
              const ops = startSpy.getCall(0).args[0].ops
              assert.ok(!('comment' in ops))
            })
            .then(done)
            .catch(done)

          server.insert(`test.${collection}`, [{ a: 1 }], () => {})
        })
      })

      describe('with dbmPropagationMode explicitly disabled', () => {
        before(() => {
          return agent.load('mongodb-core', { dbmPropagationMode: 'disabled' })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(done => {
          const Server = getServer()

          server = new Server({
            host: '127.0.0.1',
            port: 27017,
            reconnect: false
          })

          server.on('connect', () => done())
          server.on('error', done)

          server.connect()

          startSpy = sinon.spy(MongodbCorePlugin.prototype, 'start')
        })

        afterEach(() => {
          startSpy?.restore()
        })

        it('DBM propagation should not inject comment', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(startSpy.called, true)
              const { comment } = startSpy.getCall(0).args[0].ops
              assert.strictEqual(comment, undefined)
            })
            .then(done)
            .catch(done)

          server.insert(`test.${collection}`, [{ a: 1 }], () => {})
        })

        it('DBM propagation should not alter existing comment', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(startSpy.called, true)
              const { comment } = startSpy.getCall(0).args[0].ops
              assert.strictEqual(comment, 'test comment')
            })
            .then(done)
            .catch(done)

          server.command(`test.${collection}`, {
            find: `test.${collection}`,
            query: {
              _id: Buffer.from('1234')
            },
            comment: 'test comment'
          }, () => {})
        })
      })

      describe('with dbmPropagationMode service', () => {
        before(() => {
          return agent.load('mongodb-core', { dbmPropagationMode: 'service' })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(done => {
          const Server = getServer()

          server = new Server({
            host: '127.0.0.1',
            port: 27017,
            reconnect: false
          })

          server.on('connect', () => done())
          server.on('error', done)

          server.connect()

          startSpy = sinon.spy(MongodbCorePlugin.prototype, 'start')
        })

        afterEach(() => {
          startSpy?.restore()
        })

        it('DBM propagation should inject service mode as comment', done => {
          agent
            .assertSomeTraces(traces => {
              const span = traces[0][0]

              assert.strictEqual(startSpy.called, true)
              const { comment } = startSpy.getCall(0).args[0].ops
              assert.strictEqual(comment,
                `dddb='${encodeURIComponent(span.meta['db.name'])}',` +
                'dddbs=\'test-mongodb\',' +
                'dde=\'tester\',' +
                `ddh='${encodeURIComponent(span.meta['out.host'])}',` +
                `ddps='${encodeURIComponent(span.meta.service)}',` +
                `ddpv='${ddpv}',` +
                `ddprs='${encodeURIComponent(span.meta['peer.service'])}'`
              )
            })
            .then(done)
            .catch(done)

          server.insert(`test.${collection}`, [{ a: 1 }], () => {})
        })

        it('DBM propagation should inject service mode after eixsting str comment', done => {
          agent
            .assertSomeTraces(traces => {
              const span = traces[0][0]

              assert.strictEqual(startSpy.called, true)
              const { comment } = startSpy.getCall(0).args[0].ops
              assert.strictEqual(comment,
                'test comment,' +
                `dddb='${encodeURIComponent(span.meta['db.name'])}',` +
                'dddbs=\'test-mongodb\',' +
                'dde=\'tester\',' +
                `ddh='${encodeURIComponent(span.meta['out.host'])}',` +
                `ddps='${encodeURIComponent(span.meta.service)}',` +
                `ddpv='${ddpv}',` +
                `ddprs='${encodeURIComponent(span.meta['peer.service'])}'`
              )
            })
            .then(done)
            .catch(done)

          server.command(`test.${collection}`, {
            find: `test.${collection}`,
            query: {
              _id: Buffer.from('1234')
            },
            comment: 'test comment'
          }, () => {})
        })

        it('DBM propagation should inject service mode after existing array comment', done => {
          agent
            .assertSomeTraces(traces => {
              const span = traces[0][0]

              assert.strictEqual(startSpy.called, true)
              const { comment } = startSpy.getCall(0).args[0].ops
              assert.deepStrictEqual(comment, [
                'test comment',
                `dddb='${encodeURIComponent(span.meta['db.name'])}',` +
                'dddbs=\'test-mongodb\',' +
                'dde=\'tester\',' +
                `ddh='${encodeURIComponent(span.meta['out.host'])}',` +
                `ddps='${encodeURIComponent(span.meta.service)}',` +
                `ddpv='${ddpv}',` +
                `ddprs='${encodeURIComponent(span.meta['peer.service'])}'`
              ])
            })
            .then(done)
            .catch(done)

          server.command(`test.${collection}`, {
            find: `test.${collection}`,
            query: {
              _id: Buffer.from('1234')
            },
            comment: ['test comment']
          }, () => {})
        })
      })

      describe('with dbmPropagationMode full', () => {
        before(() => {
          tracer._tracer.configure({ sampler: { sampleRate: 1 } })
          return agent.load('mongodb-core', { dbmPropagationMode: 'full' })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(done => {
          const Server = getServer()

          server = new Server({
            host: '127.0.0.1',
            port: 27017,
            reconnect: false
          })

          server.on('connect', () => done())
          server.on('error', done)

          server.connect()

          startSpy = sinon.spy(MongodbCorePlugin.prototype, 'start')
        })

        afterEach(() => {
          startSpy?.restore()
        })

        it('DBM propagation should inject full mode with traceparent as comment', done => {
          agent
            .assertFirstTraceSpan(span => {
              const traceId = span.meta['_dd.p.tid'] + span.trace_id.toString(16).padStart(16, '0')
              const spanId = span.span_id.toString(16).padStart(16, '0')

              assert.strictEqual(startSpy.called, true)
              const { comment } = startSpy.getCall(0).args[0].ops
              assert.strictEqual(comment,
                `dddb='${encodeURIComponent(span.meta['db.name'])}',` +
                'dddbs=\'test-mongodb\',' +
                'dde=\'tester\',' +
                `ddh='${encodeURIComponent(span.meta['out.host'])}',` +
                `ddps='${encodeURIComponent(span.meta.service)}',` +
                `ddpv='${ddpv}',` +
                `ddprs='${encodeURIComponent(span.meta['peer.service'])}',` +
                `traceparent='00-${traceId}-${spanId}-01'`
              )
            })
            .then(done)
            .catch(done)

          server.insert(`test.${collection}`, [{ a: 1 }], () => {})
        })
      })

      describe('with dbmPropagationMode full but sampling disabled', () => {
        before(() => {
          tracer._tracer.configure({ env: 'tester', sampler: { sampleRate: 0 } })

          return agent.load('mongodb-core', { dbmPropagationMode: 'full' })
        })

        after(() => {
          tracer._tracer.configure({ env: 'tester', sampler: { sampleRate: 1 } })

          return agent.close({ ritmReset: false })
        })

        beforeEach(done => {
          const Server = getServer()

          server = new Server({
            host: '127.0.0.1',
            port: 27017,
            reconnect: false
          })

          server.on('connect', () => done())
          server.on('error', done)

          server.connect()

          startSpy = sinon.spy(MongodbCorePlugin.prototype, 'start')
        })

        afterEach(() => {
          startSpy?.restore()
        })

        it(
          'DBM propagation should inject full mode with traceparent as comment and the rejected sampling decision',
          done => {
            agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                const traceId = span.meta['_dd.p.tid'] + span.trace_id.toString(16).padStart(16, '0')
                const spanId = span.span_id.toString(16).padStart(16, '0')

                assert.strictEqual(startSpy.called, true)
                const { comment } = startSpy.getCall(0).args[0].ops
                assert.match(
                  comment,
                  new RegExp(String.raw`traceparent='00-${traceId}-${spanId}-00'`)
                )
              })
              .then(done)
              .catch(done)

            server.insert(`test.${collection}`, [{ a: 1 }], () => {})
          })
      })
    })
  })
})
