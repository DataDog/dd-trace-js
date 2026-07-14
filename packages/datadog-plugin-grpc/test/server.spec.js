'use strict'

const assert = require('node:assert/strict')
const Readable = require('node:stream').Readable
const path = require('node:path')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const satisfies = require('semifies')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { defaults } = require('../../dd-trace/src/config/defaults')
const { NODE_MAJOR } = require('../../../version')

const GRPC_SERVER_ERROR_STATUSES = defaults.DD_GRPC_SERVER_ERROR_STATUSES

const pkgs = NODE_MAJOR > 14 ? ['@grpc/grpc-js'] : ['grpc', '@grpc/grpc-js']

describe('Plugin', () => {
  describe('grpc/server', () => {
    withVersions('grpc', pkgs, NODE_MAJOR >= 25 ? '>=1.3.0' : '*', (version, pkg, resolvedVersion) => {
      let grpc
      let port = 0
      let server
      let tracer
      let call

      function buildClient (service) {
        service = {
          getBidi: () => {},
          getServerStream: () => {},
          getClientStream: () => {},
          getUnary: () => {},
          ...service,
        }

        const loader = require('../../../versions/@grpc/proto-loader').get()
        const definition = loader.loadSync(path.join(__dirname, 'test.proto'))
        const TestService = grpc.loadPackageDefinition(definition).test.TestService

        server = new grpc.Server()

        return new Promise((resolve, reject) => {
          if (server.bindAsync) {
            server.bindAsync('0.0.0.0:0', grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
              if (err) return reject(err)
              port = boundPort

              server.addService(TestService.service, service)

              if (satisfies(resolvedVersion, '<1.10.0')) {
                server.start()
              }

              resolve(new TestService(`localhost:${port}`, grpc.credentials.createInsecure()))
            })
          } else {
            port = server.bind('0.0.0.0:0', grpc.ServerCredentials.createInsecure())
            server.addService(TestService.service, service)
            server.start()

            resolve(new TestService(`localhost:${port}`, grpc.credentials.createInsecure()))
          }
        })
      }

      beforeEach(() => {
        call = null
      })

      afterEach(() => {
        server.forceShutdown()
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load('grpc', { client: false })
            .then(() => {
              tracer = require('../../dd-trace')
              grpc = require(`../../../versions/${pkg}@${version}`).get()
            })
        })

        after(() => {
          return agent.close()
        })

        withNamingSchema(
          async () => {
            const client = await buildClient({
              getUnary: (_, callback) => callback(),
            })

            client.getUnary({ first: 'foobar' }, () => {})
          },
          {
            v0: {
              opName: 'grpc.server',
              serviceName: 'test',
            },
            v1: {
              opName: 'grpc.server.request',
              serviceName: 'test',
            },
          }
        )

        it('should handle `unary` calls', async () => {
          const client = await buildClient({
            getUnary: (_, callback) => callback(),
          })

          client.getUnary({ first: 'foobar' }, () => {})

          return agent
            .assertSomeTraces(traces => {
              assertObjectContains(traces[0][0], {
                name: 'grpc.server',
                service: 'test',
                resource: '/test.TestService/getUnary',
                type: 'web',
              })
              assert.strictEqual(traces[0][0].meta['grpc.method.name'], 'getUnary')
              assert.strictEqual(traces[0][0].meta['grpc.method.service'], 'TestService')
              assert.strictEqual(traces[0][0].meta['grpc.method.package'], 'test')
              assert.strictEqual(traces[0][0].meta['grpc.method.path'], '/test.TestService/getUnary')
              assert.strictEqual(traces[0][0].meta['grpc.method.kind'], 'unary')
              assert.strictEqual(traces[0][0].meta['span.kind'], 'server')
              assert.strictEqual(traces[0][0].meta.component, 'grpc')
              assert.strictEqual(traces[0][0].metrics['grpc.status.code'], 0)
            })
        })

        it('should handle `stream` calls', async () => {
          const client = await buildClient({
            getServerStream: stream => stream.end(),
          })

          client.getServerStream({ first: 'foobar' }, () => {})

          return agent
            .assertSomeTraces(traces => {
              assertObjectContains(traces[0][0], {
                name: 'grpc.server',
                service: 'test',
                resource: '/test.TestService/getServerStream',
                type: 'web',
              })
              assert.strictEqual(traces[0][0].meta['grpc.method.name'], 'getServerStream')
              assert.strictEqual(traces[0][0].meta['grpc.method.service'], 'TestService')
              assert.strictEqual(traces[0][0].meta['grpc.method.path'], '/test.TestService/getServerStream')
              assert.strictEqual(traces[0][0].meta['grpc.method.kind'], 'server_streaming')
              assert.strictEqual(traces[0][0].meta['span.kind'], 'server')
              assert.strictEqual(traces[0][0].metrics['grpc.status.code'], 0)
              assert.strictEqual(traces[0][0].meta.component, 'grpc')
            })
        })

        it('should handle `bidi` calls', async () => {
          const client = await buildClient({
            getBidi: stream => stream.end(),
          })

          call = client.getBidi(new Readable(), () => {})
          call.on('error', () => {})

          return agent
            .assertSomeTraces(traces => {
              assertObjectContains(traces[0][0], {
                name: 'grpc.server',
                service: 'test',
                resource: '/test.TestService/getBidi',
                type: 'web',
              })
              assert.strictEqual(traces[0][0].meta['grpc.method.name'], 'getBidi')
              assert.strictEqual(traces[0][0].meta['grpc.method.service'], 'TestService')
              assert.strictEqual(traces[0][0].meta['grpc.method.path'], '/test.TestService/getBidi')
              assert.strictEqual(traces[0][0].meta['grpc.method.kind'], 'bidi_streaming')
              assert.strictEqual(traces[0][0].meta['span.kind'], 'server')
              assert.strictEqual(traces[0][0].metrics['grpc.status.code'], 0)
              assert.strictEqual(traces[0][0].meta.component, 'grpc')
            })
        })

        it('should handle cancelled `unary` calls', async () => {
          let call = null
          const client = await buildClient({
            getUnary: () => call.cancel(),
          })

          call = client.getUnary({ first: 'foobar' }, () => {})
          call.on('error', () => {})

          return agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].metrics['grpc.status.code'], 1)
            })
        })

        it('should handle cancelled `stream` calls', async () => {
          let call = null
          const client = await buildClient({
            getServerStream: () => call.cancel(),
          })

          call = client.getServerStream({ first: 'foobar' }, () => {})
          call.on('error', () => {})

          return agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].metrics['grpc.status.code'], 1)
            })
        })

        it('should handle cancelled `bidi` calls', async () => {
          const client = await buildClient({
            getBidi: () => call.cancel(),
          })

          call = client.getBidi(new Readable(), () => {})
          call.on('error', () => {})

          return agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].metrics['grpc.status.code'], 1)
            })
        })

        it('should handle errors without `code`', async () => {
          const client = await buildClient({
            getUnary: (_, callback) => {
              const metadata = new grpc.Metadata()

              metadata.set('extra', 'information')

              callback(new Error('foobar'), {}, metadata)
            },
          })

          client.getUnary({ first: 'foobar' }, () => {})

          return agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].error, 1)
              assert.strictEqual(traces[0][0].meta[ERROR_MESSAGE], 'foobar')
              assert.strictEqual(traces[0][0].meta[ERROR_TYPE], 'Error')
              assert.ok(!('grpc.status.code' in traces[0][0].meta))
            })
        })

        it('should handle errors with `code`', async () => {
          const client = await buildClient({
            getUnary: (_, callback) => {
              const metadata = new grpc.Metadata()

              metadata.set('extra', 'information')

              const error = new Error('foobar')

              error.code = grpc.status.NOT_FOUND

              const childOf = tracer.scope().active()
              const child = tracer.startSpan('child', { childOf })

              // Delay trace to ensure auto-cancellation doesn't override the status code.
              setTimeout(() => child.finish())

              callback(error, {}, metadata)
            },
          })

          client.getUnary({ first: 'foobar' }, () => {})

          return agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].error, 1)
              assert.strictEqual(traces[0][0].meta[ERROR_MESSAGE], 'foobar')
              assert.match(traces[0][0].meta[ERROR_STACK], /^Error: foobar\n {4}at Object.getUnary.*/)
              assert.strictEqual(traces[0][0].meta[ERROR_TYPE], 'Error')
              assert.strictEqual(traces[0][0].metrics['grpc.status.code'], 5)
              assert.strictEqual(traces[0][0].meta.component, 'grpc')
            })
        })

        it('should ignore errors not set by DD_GRPC_SERVER_ERROR_STATUSES', async () => {
          tracer._tracer._config.DD_GRPC_SERVER_ERROR_STATUSES = [6, 7, 8, 9, 10, 11, 12, 13]
          const client = await buildClient({
            getUnary: (_, callback) => {
              const metadata = new grpc.Metadata()

              metadata.set('extra', 'information')

              const error = new Error('foobar')

              error.code = grpc.status.NOT_FOUND

              const childOf = tracer.scope().active()
              const child = tracer.startSpan('child', { childOf })

              // Delay trace to ensure auto-cancellation doesn't override the status code.
              setTimeout(() => child.finish())

              callback(error, {}, metadata)
            },
          })

          client.getUnary({ first: 'foobar' }, () => {})

          return agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].error, 0)
              assert.strictEqual(traces[0][0].metrics['grpc.status.code'], 5)
              tracer._tracer._config.DD_GRPC_SERVER_ERROR_STATUSES = GRPC_SERVER_ERROR_STATUSES
            })
        })

        it('should handle custom errors', async () => {
          const client = await buildClient({
            getUnary: (_, callback) => {
              const metadata = new grpc.Metadata()

              metadata.set('extra', 'information')

              callback({ message: 'foobar', code: grpc.status.NOT_FOUND }, {}, metadata)
            },
          })

          client.getUnary({ first: 'foobar' }, () => {})

          return agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].error, 1)
              assert.strictEqual(traces[0][0].meta[ERROR_MESSAGE], 'foobar')
              assert.strictEqual(traces[0][0].metrics['grpc.status.code'], 5)
            })
        })

        it('should handle stream errors', async () => {
          let error = null

          const client = await buildClient({
            getBidi: (stream) => {
              error = new Error('foobar')
              error.code = grpc.status.NOT_FOUND

              stream.emit('error', error)
            },
          })

          call = client.getBidi(new Readable(), () => {})
          call.on('error', () => {})

          return agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].error, 1)
              assert.strictEqual(traces[0][0].meta[ERROR_MESSAGE], 'foobar')
              assert.strictEqual(traces[0][0].meta[ERROR_STACK], error.stack)
              assert.strictEqual(traces[0][0].meta[ERROR_TYPE], 'Error')
              assert.strictEqual(traces[0][0].metrics['grpc.status.code'], 5)
            })
        })

        it('should run the handler in the scope of the request', done => {
          buildClient({
            getUnary: (_, callback) => {
              try {
                callback()
                assert.notStrictEqual(tracer.scope().active(), null)
                done()
              } catch (e) {
                done(e)
              }
            },
          }).then(client => client.getUnary({ first: 'foobar' }, () => {}), done)
        })

        it('should run the emitter in the scope of the caller', done => {
          let emitter = null

          buildClient({
            getUnary: (call, callback) => {
              const span = tracer.scope().active()

              emitter = call
              emitter.on('test', () => {
                assert.strictEqual(tracer.scope().active(), span)
                assert.notStrictEqual(span, null)
                done()
              })

              callback(null, {})
            },
          }).then(client => {
            client.getUnary({ first: 'foobar' }, () => {
              emitter.emit('test')
            })
          }, done)
        })
      })

      describe('with service configuration', () => {
        before(() => {
          const config = {
            server: {
              service: 'custom',
            },
            client: false,
          }

          return agent.load('grpc', config)
            .then(() => {
              grpc = require(`../../../versions/${pkg}@${version}`).get()
            })
        })

        after(() => {
          return agent.close()
        })

        it('should be configured with the correct values', async () => {
          const client = await buildClient({
            getUnary: (_, callback) => callback(),
          })

          client.getUnary({ first: 'foobar' }, () => {})

          return agent.assertFirstTraceSpan({
            service: 'custom',
          })
        })
      })

      describe('with metadata configuration', () => {
        before(() => {
          const config = {
            server: {
              metadata: values => values,
            },
            client: false,
          }

          return agent.load('grpc', config)
            .then(() => {
              grpc = require(`../../../versions/${pkg}@${version}`).get()
            })
        })

        after(() => {
          return agent.close()
        })

        it('should handle request metadata', async () => {
          const client = await buildClient({
            getUnary: (_, callback) => callback(),
          })

          const metadata = new grpc.Metadata()

          metadata.set('foo', 'bar')

          client.getUnary({ first: 'foobar' }, metadata, () => {})

          return agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].meta['grpc.request.metadata.foo'], 'bar')
            })
        })

        it('should handle response metadata', async () => {
          const client = await buildClient({
            getUnary: (_, callback) => {
              const metadata = new grpc.Metadata()

              metadata.set('foo', 'bar')

              callback(null, {}, metadata)
            },
          })

          client.getUnary({ first: 'foobar' }, () => {})

          return agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].meta['grpc.response.metadata.foo'], 'bar')
            })
        })

        it('should not alter the request metadata', done => {
          buildClient({
            getUnary: (call, callback) => {
              callback(null, {})

              try {
                assert.ok('foo' in call.metadata.getMap())
                assert.strictEqual(call.metadata.getMap().foo, 'bar')
                done()
              } catch (e) {
                done(e)
              }
            },
          }).then(client => {
            const metadata = new grpc.Metadata()

            metadata.set('foo', 'bar')

            client.getUnary({ first: 'foobar' }, metadata, () => {})
          }, done)
        })
      })

      // gRPC serves over a core Node Http2Server. With the http2 server plugin
      // also enabled, that server's 'stream' events must not be traced by http2:
      // gRPC owns the span, so a call keeps a single grpc.server span rather than
      // gaining a web.request span that steals the top frame.
      describe('with http2 server tracing also enabled', () => {
        before(() => {
          return agent.load(['grpc', 'http2'], { client: false })
            .then(() => {
              tracer = require('../../dd-trace')
              grpc = require(`../../../versions/${pkg}@${version}`).get()
            })
        })

        after(() => {
          return agent.close()
        })

        it('produces only the grpc.server span, no web.request span', async () => {
          const spans = []
          const collect = traces => spans.push(...traces.flat())
          agent.subscribe(collect)

          try {
            const client = await buildClient({ getUnary: (_, callback) => callback(null, {}) })
            client.getUnary({ first: 'foobar' }, () => {})

            await agent.assertSomeTraces(traces => {
              assertObjectContains(traces[0][0], { name: 'grpc.server', meta: { component: 'grpc' } })
            })

            const httpSpans = spans.filter(span => span.name === 'web.request')
            assert.deepStrictEqual(httpSpans, [], 'gRPC call must not produce a web.request span')

            // With no web.request span at all, gRPC is necessarily the top server
            // frame; assert the span is present so a silent drop can't pass this.
            assert.ok(spans.some(span => span.name === 'grpc.server'), 'expected a grpc.server span')
          } finally {
            agent.unsubscribe(collect)
          }
        })

        it('does not produce a web.request span for a non-gRPC request to the gRPC port', async () => {
          const http2 = require('node:http2')
          await buildClient({ getUnary: (_, callback) => callback(null, {}) })

          const spans = []
          const collect = traces => spans.push(...traces.flat())
          agent.subscribe(collect)

          try {
            // A plain HTTP/2 request with no gRPC content-type: the gRPC server
            // rejects it with 415, and its 'stream' event must still not be
            // traced as http2 because gRPC owns the server.
            await new Promise((resolve, reject) => {
              const client = http2.connect(`http://127.0.0.1:${port}`).on('error', reject)
              const req = client.request({ ':path': '/', ':method': 'GET' })
              req.on('error', reject)
              req.on('end', () => {
                client.close()
                resolve()
              })
              req.resume()
              req.end()
            })

            for (let drain = 0; drain < 5; drain++) await new Promise(setImmediate)

            const httpSpans = spans.filter(span => span.name === 'web.request')
            assert.deepStrictEqual(httpSpans, [], 'a non-gRPC request to a gRPC server must not be traced as http2')
          } finally {
            agent.unsubscribe(collect)
          }
        })
      })
    })
  })
})
