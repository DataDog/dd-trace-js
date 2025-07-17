'use strict'

const sinon = require('sinon')
const semver = require('semver')
const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { expectedSchema, rawExpectedSchema } = require('./naming')

const MongodbCorePlugin = require('../../datadog-plugin-mongodb-core/src/index')
const ddpv = require('mocha/package.json').version

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
        server.destroy()
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

                expect(span).to.have.property('name', expectedSchema.outbound.opName)
                expect(span).to.have.property('service', expectedSchema.outbound.serviceName)
                expect(span).to.have.property('resource', resource)
                expect(span).to.have.property('type', 'mongodb')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('db.name', `test.${collection}`)
                expect(span.meta).to.have.property('out.host', '127.0.0.1')
                expect(span.meta).to.have.property('component', 'mongodb')
                expect(span.meta).to.have.property('_dd.integration', 'mongodb')
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

                expect(span).to.have.property('resource', resource)
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

                expect(span).to.have.property('resource', resource)
                expect(span.meta).to.have.property('mongodb.query', query)
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

                expect(span).to.have.property('resource', resource)
                expect(span.meta).to.have.property('mongodb.query', query)
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

                expect(span).to.have.property('resource', resource)
                expect(span.meta).to.have.property('mongodb.query', query)
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

                expect(span).to.have.property('resource', resource)
                expect(span.meta).to.have.property('mongodb.query', query)
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
              expect(tracer.scope().active()).to.be.null
              done()
            })
          })

          it('should handle errors', done => {
            let error

            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
                expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
                expect(traces[0][0].meta).to.have.property('component', 'mongodb')
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
                .assertSomeTraces(traces => {
                  expect(traces[0][0].resource).to.equal(`find test.${collection}`)
                }),
              agent
                .assertSomeTraces(traces => {
                  expect(traces[0][0].resource).to.equal(`getMore test.${collection}`)
                }),
              agent
                .assertSomeTraces(traces => {
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
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                const resource = `find test.${collection}`
                const query = '{"foo":1,"bar":{"baz":[1,2,3]}}'

                expect(span).to.have.property('resource', resource)
                expect(span.meta).to.have.property('mongodb.query', query)
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
              expect(tracer.scope().active()).to.be.null
              done()
            })
          })

          it('should handle errors', done => {
            let error

            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
                expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
                expect(traces[0][0].meta).to.have.property('component', 'mongodb')
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
              expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
              expect(traces[0][0]).to.have.property('service', 'custom')
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
              expect(startSpy.called).to.be.true
              const ops = startSpy.getCall(0).args[0].ops
              expect(ops).to.not.have.property('comment')
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
              expect(startSpy.called).to.be.true
              const { comment } = startSpy.getCall(0).args[0].ops
              expect(comment).to.be.undefined
            })
            .then(done)
            .catch(done)

          server.insert(`test.${collection}`, [{ a: 1 }], () => {})
        })

        it('DBM propagation should not alter existing comment', done => {
          agent
            .assertSomeTraces(traces => {
              expect(startSpy.called).to.be.true
              const { comment } = startSpy.getCall(0).args[0].ops
              expect(comment).to.equal('test comment')
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

              expect(startSpy.called).to.be.true
              const { comment } = startSpy.getCall(0).args[0].ops
              expect(comment).to.equal(
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

              expect(startSpy.called).to.be.true
              const { comment } = startSpy.getCall(0).args[0].ops
              expect(comment).to.equal(
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

        it('DBM propagation should inject service mode after eixsting array comment', done => {
          agent
            .assertSomeTraces(traces => {
              const span = traces[0][0]

              expect(startSpy.called).to.be.true
              const { comment } = startSpy.getCall(0).args[0].ops
              expect(comment).to.deep.equal([
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
            .assertSomeTraces(traces => {
              const span = traces[0][0]
              const traceId = span.meta['_dd.p.tid'] + span.trace_id.toString(16).padStart(16, '0')
              const spanId = span.span_id.toString(16).padStart(16, '0')

              expect(startSpy.called).to.be.true
              const { comment } = startSpy.getCall(0).args[0].ops
              expect(comment).to.equal(
                `dddb='${encodeURIComponent(span.meta['db.name'])}',` +
                'dddbs=\'test-mongodb\',' +
                'dde=\'tester\',' +
                `ddh='${encodeURIComponent(span.meta['out.host'])}',` +
                `ddps='${encodeURIComponent(span.meta.service)}',` +
                `ddpv='${ddpv}',` +
                `ddprs='${encodeURIComponent(span.meta['peer.service'])}',` +
                `traceparent='00-${traceId}-${spanId}-00'`
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
