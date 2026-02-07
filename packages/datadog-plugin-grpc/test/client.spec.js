'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const Readable = require('node:stream').Readable

const { after, afterEach, before, describe, it } = require('mocha')
const semver = require('semver')
const { assertObjectContains } = require('../../../integration-tests/helpers')

const loader = require('../../../versions/@grpc/proto-loader').get()
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK, GRPC_CLIENT_ERROR_STATUSES } = require('../../dd-trace/src/constants')
const { NODE_MAJOR } = require('../../../version')
const getService = require('./service')

const pkgs = NODE_MAJOR > 14 ? ['@grpc/grpc-js'] : ['grpc', '@grpc/grpc-js']

describe('Plugin', () => {
  describe('grpc/client', () => {
    withVersions('grpc', pkgs, NODE_MAJOR >= 25 && '>=1.3.0' || '*', (version, pkg, resolvedVersion) => {
      let grpc
      let port = 0
      let server
      let tracer

      const clientBuilders = {
        protobuf: buildProtoClient,
        custom: buildCustomClient,
      }

      function buildGenericService (grpc, service, TestService, ClientService, currentVersion) {
        service = Object.assign({
          getBidi: () => {},
          getServerStream: () => {},
          getClientStream: () => {},
          getUnary: () => {},
        }, service)

        server = new grpc.Server()

        return new Promise((resolve, reject) => {
          ClientService = ClientService || TestService

          if (server.bindAsync) {
            server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
              if (err) return reject(err)
              port = boundPort

              server.addService(TestService.service, service)

              if (semver.satisfies(currentVersion, '<1.10.0')) {
                server.start()
              }

              resolve(new ClientService(`127.0.0.1:${port}`, grpc.credentials.createInsecure()))
            })
          } else {
            port = server.bind('127.0.0.1:0', grpc.ServerCredentials.createInsecure())
            server.addService(TestService.service, service)
            server.start()

            resolve(new ClientService(`127.0.0.1:${port}`, grpc.credentials.createInsecure()))
          }
        })
      }

      function buildProtoClient (grpc, service, ClientService, currentVersion) {
        const definition = loader.loadSync(path.join(__dirname, 'test.proto'))
        const TestService = grpc.loadPackageDefinition(definition).test.TestService

        return buildGenericService(grpc, service, TestService, ClientService, currentVersion)
      }

      function buildCustomClient (grpc, service, ClientService, currentVersion) {
        const TestService = getService(grpc)

        return buildGenericService(grpc, service, TestService, ClientService, currentVersion)
      }

      afterEach(() => {
        server.forceShutdown()
      })

      for (const clientName of Object.keys(clientBuilders)) {
        const buildClient = (service, ClientService) => {
          return clientBuilders[clientName](grpc, service, ClientService, resolvedVersion)
        }

        describe(`with ${clientName} client`, () => {
          describe('without configuration', () => {
            before(() => {
              return agent.load('grpc', { server: false })
                .then(() => {
                  tracer = require('../../dd-trace')
                  grpc = require(`../../../versions/${pkg}@${version}`).get()
                })
            })

            after(() => {
              return agent.close({ ritmReset: false })
            })

            withPeerService(
              () => tracer,
              'grpc',
              async (done) => {
                const client = await buildClient({
                  getUnary: (_, callback) => callback(),
                })
                client.getUnary({ first: 'foobar' }, done)
              },
              'test.TestService', 'rpc.service')

            withNamingSchema(
              async () => {
                const client = await buildClient({
                  getUnary: (_, callback) => callback(),
                })
                client.getUnary({ first: 'foobar' }, () => {})
              },
              {
                v0: {
                  opName: 'grpc.client',
                  serviceName: 'test',
                },
                v1: {
                  opName: 'grpc.client.request',
                  serviceName: 'test',
                },
              }
            )

            if (semver.intersects(version, '>=1.1.4')) {
              it('should provide host information', async () => {
                const client = await buildClient({
                  getUnary: (_, callback) => callback(),
                })

                client.getUnary({ first: 'foobar' }, () => {})
                return agent.assertFirstTraceSpan({
                  meta: {
                    'network.destination.ip': '127.0.0.1',
                    'network.destination.port': port.toString(),
                    'rpc.service': 'test.TestService',
                    'span.kind': 'client',
                    component: 'grpc',
                  },
                })
              })
            }

            it('should handle `unary` calls', async () => {
              const client = await buildClient({
                getUnary: (_, callback) => callback(),
              })

              client.getUnary({ first: 'foobar' }, () => {})
              return agent
                .assertSomeTraces(traces => {
                  assertObjectContains(traces[0][0], {
                    name: 'grpc.client',
                    service: 'test',
                    resource: '/test.TestService/getUnary',
                    type: 'http',
                  })

                  assertObjectContains(traces[0][0].meta, {
                    'grpc.method.name': 'getUnary',
                    'grpc.method.service': 'TestService',
                    'grpc.method.package': 'test',
                    'grpc.method.path': '/test.TestService/getUnary',
                    'grpc.method.kind': 'unary',
                    'rpc.service': 'test.TestService',
                    'span.kind': 'client',
                    component: 'grpc',
                  })

                  assertObjectContains(traces[0][0].metrics, {
                    'grpc.status.code': 0,
                  })
                })
            })

            it('should handle `server_stream` calls', async () => {
              const client = await buildClient({
                getServerStream: stream => {
                  stream.end()
                },
              })

              const call = client.getServerStream({ first: 'foobar' })

              call.on('data', () => {})

              return agent
                .assertSomeTraces(traces => {
                  assertObjectContains(traces[0][0], {
                    name: 'grpc.client',
                    service: 'test',
                    resource: '/test.TestService/getServerStream',
                    type: 'http',
                  })

                  assertObjectContains(traces[0][0].meta, {
                    'grpc.method.name': 'getServerStream',
                    'grpc.method.service': 'TestService',
                    'grpc.method.package': 'test',
                    'grpc.method.path': '/test.TestService/getServerStream',
                    'grpc.method.kind': 'server_streaming',
                    'rpc.service': 'test.TestService',
                    'span.kind': 'client',
                    component: 'grpc',
                  })

                  assertObjectContains(traces[0][0].metrics, {
                    'grpc.status.code': 0,
                  })
                })
            })

            it('should handle `client_stream` calls', async () => {
              const client = await buildClient({
                getClientStream: (_, callback) => {
                  setTimeout(callback, 40)
                },
              })

              client.getClientStream(() => {})

              return agent
                .assertSomeTraces(traces => {
                  assertObjectContains(traces[0][0], {
                    name: 'grpc.client',
                    service: 'test',
                    resource: '/test.TestService/getClientStream',
                    type: 'http',
                  })

                  assertObjectContains(traces[0][0].meta, {
                    'grpc.method.name': 'getClientStream',
                    'grpc.method.service': 'TestService',
                    'grpc.method.package': 'test',
                    'grpc.method.path': '/test.TestService/getClientStream',
                    'grpc.method.kind': 'client_streaming',
                    'rpc.service': 'test.TestService',
                    'span.kind': 'client',
                    component: 'grpc',
                  })

                  assertObjectContains(traces[0][0].metrics, {
                    'grpc.status.code': 0,
                  })
                })
            })

            it('should handle `bidi` calls', async () => {
              const client = await buildClient({
                getBidi: stream => stream.end(),
              })

              const call = client.getBidi(new Readable())

              call.on('data', () => {})

              return agent
                .assertSomeTraces(traces => {
                  assertObjectContains(traces[0][0], {
                    name: 'grpc.client',
                    service: 'test',
                    resource: '/test.TestService/getBidi',
                    type: 'http',
                  })
                  assert.strictEqual(traces[0][0].meta['grpc.method.name'], 'getBidi')
                  assert.strictEqual(traces[0][0].meta['grpc.method.service'], 'TestService')
                  assert.strictEqual(traces[0][0].meta['grpc.method.path'], '/test.TestService/getBidi')
                  assert.strictEqual(traces[0][0].meta['grpc.method.kind'], 'bidi_streaming')
                  assert.strictEqual(traces[0][0].meta['rpc.service'], 'test.TestService')
                  assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
                  assert.strictEqual(traces[0][0].metrics['grpc.status.code'], 0)
                  assert.strictEqual(traces[0][0].meta.component, 'grpc')
                  assert.strictEqual(traces[0][0].meta['_dd.integration'], 'grpc')
                })
            })

            it('should handle cancelled `unary` calls', async () => {
              let call = null
              const client = await buildClient({
                getUnary: () => call.cancel(),
              })

              call = client.getUnary({ first: 'foobar' }, () => {})

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

              call = client.getServerStream({ first: 'foobar' })
              call.on('data', () => {})
              call.on('error', () => {})

              return agent
                .assertSomeTraces(traces => {
                  assert.strictEqual(traces[0][0].metrics['grpc.status.code'], 1)
                })
            })

            it('should handle cancelled `bidi` calls', async () => {
              let call = null
              const client = await buildClient({
                getBidi: () => call.cancel(),
              })

              call = client.getBidi(new Readable(), () => {})
              call.on('data', () => {})
              call.on('error', () => {})

              return agent
                .assertSomeTraces(traces => {
                  assert.strictEqual(traces[0][0].metrics['grpc.status.code'], 1)
                })
            })

            it('should handle errors', async () => {
              const client = await buildClient({
                getUnary: (_, callback) => callback(new Error('foobar')),
              })

              client.getUnary({ first: 'foobar' }, () => {})

              return agent
                .assertSomeTraces(traces => {
                  assertObjectContains(traces[0][0], {
                    error: 1,
                    meta: {
                      [ERROR_MESSAGE]: '2 UNKNOWN: foobar',
                      [ERROR_TYPE]: 'Error',
                      'grpc.method.name': 'getUnary',
                      'grpc.method.service': 'TestService',
                      'grpc.method.package': 'test',
                      'grpc.method.path': '/test.TestService/getUnary',
                      'grpc.method.kind': 'unary',
                      'rpc.service': 'test.TestService',
                      'span.kind': 'client',
                      component: 'grpc',
                    },
                  })

                  assert.ok(Object.hasOwn(traces[0][0].meta, ERROR_STACK))
                  assert.strictEqual(traces[0][0].metrics['grpc.status.code'], 2)
                })
            })

            it('should ignore errors not set by DD_GRPC_CLIENT_ERROR_STATUSES', async () => {
              tracer._tracer._config.grpc.client.error.statuses = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
              const client = await buildClient({
                getUnary: (_, callback) => callback(new Error('foobar')),
              })

              client.getUnary({ first: 'foobar' }, () => {})

              return agent
                .assertSomeTraces(traces => {
                  assert.strictEqual(traces[0][0].error, 0)
                  assert.strictEqual(traces[0][0].metrics['grpc.status.code'], 2)
                  tracer._tracer._config.grpc.client.error.statuses =
                  GRPC_CLIENT_ERROR_STATUSES
                })
            })

            it('should handle protocol errors', async () => {
              const definition = loader.loadSync(path.join(__dirname, 'invalid.proto'))
              const test = grpc.loadPackageDefinition(definition).test
              const client = await buildClient({
                getUnary: (_, callback) => callback(null),
              }, test.TestService)

              client.getUnary({ first: 'foobar' }, () => {})

              return agent
                .assertSomeTraces(traces => {
                  assertObjectContains(traces[0][0], {
                    error: 1,
                    meta: {
                      [ERROR_TYPE]: 'Error',
                      'grpc.method.name': 'getUnary',
                      'grpc.method.service': 'TestService',
                      'grpc.method.package': 'test',
                      'grpc.method.path': '/test.TestService/getUnary',
                      'grpc.method.kind': 'unary',
                      'rpc.service': 'test.TestService',
                      'span.kind': 'client',
                      component: 'grpc',
                    },
                  })

                  assert.ok(Object.hasOwn(traces[0][0].meta, ERROR_STACK))
                  assert.match(traces[0][0].meta[ERROR_MESSAGE], /^13 INTERNAL:.+$/m)
                  assert.strictEqual(traces[0][0].metrics['grpc.status.code'], 13)
                })
            })

            it('should handle property named "service"', async () => {
              const definition = loader.loadSync(path.join(__dirname, 'hasservice.proto'))
              const thing = grpc.loadPackageDefinition(definition).thing
              await buildClient({
                getUnary: (_, callback) => callback(null),
              }, thing.service.ThingService)
            })

            it('should handle a missing callback', async () => {
              const client = await buildClient({
                getUnary: (_, callback) => callback(),
              })

              client.getUnary({ first: 'foobar' })

              return agent
                .assertSomeTraces(traces => {
                  assertObjectContains(traces[0][0], {
                    name: 'grpc.client',
                    service: 'test',
                    resource: '/test.TestService/getUnary',
                  })

                  assertObjectContains(traces[0][0].meta, {
                    'grpc.method.name': 'getUnary',
                    'grpc.method.service': 'TestService',
                    'grpc.method.package': 'test',
                    'grpc.method.path': '/test.TestService/getUnary',
                    'rpc.service': 'test.TestService',
                    'grpc.method.kind': 'unary',
                    'span.kind': 'client',
                    component: 'grpc',
                  })

                  assertObjectContains(traces[0][0].metrics, {
                    'grpc.status.code': 0,
                  })
                })
            })

            it('should handle undefined metadata', async () => {
              const client = await buildClient({
                getUnary: (_, callback) => callback(),
              })

              client.getUnary({ first: 'foobar' }, undefined, () => {})

              return agent
                .assertSomeTraces(traces => {
                  assertObjectContains(traces[0][0], {
                    name: 'grpc.client',
                    service: 'test',
                    resource: '/test.TestService/getUnary',
                  })

                  assertObjectContains(traces[0][0].meta, {
                    'grpc.method.name': 'getUnary',
                    'grpc.method.service': 'TestService',
                    'grpc.method.package': 'test',
                    'grpc.method.path': '/test.TestService/getUnary',
                    'grpc.method.kind': 'unary',
                    'rpc.service': 'test.TestService',
                    'span.kind': 'client',
                    component: 'grpc',
                  })

                  assertObjectContains(traces[0][0].metrics, {
                    'grpc.status.code': 0,
                  })
                })
            })

            it('should inject its parent span in the metadata', done => {
              buildClient({
                getUnary: (call, callback) => {
                  const metadata = call.metadata.getMap()

                  callback(null, {})

                  try {
                    assert.strictEqual(metadata.foo, 'bar')
                    assert.strictEqual(typeof metadata['x-datadog-trace-id'], 'string')
                    assert.strictEqual(typeof metadata['x-datadog-parent-id'], 'string')

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

            it('should propagate the parent scope to the callback', done => {
              const span = {}

              buildClient({
                getUnary: (call, callback) => callback(),
              }).then(client => {
                tracer.scope().activate(span, () => {
                  client.getUnary({ first: 'foobar' }, (err, response) => {
                    assert.strictEqual(tracer.scope().active(), span)
                    done(err)
                  })
                })
              }, done)
            })

            it('should propagate the parent scope to event listeners', done => {
              const span = {}

              buildClient({
                getServerStream: stream => {
                  stream.write('test')
                  stream.end()
                },
              }).then(client => {
                tracer.scope().activate(span, () => {
                  const call = client.getServerStream({ first: 'foobar' })

                  call.on('data', () => {
                    assert.strictEqual(tracer.scope().active(), span)
                    done()
                  })
                })
              }, done)
            })
          })

          describe('with service configuration', () => {
            before(() => {
              const config = {
                client: {
                  service: 'custom',
                },
                server: false,
              }

              return agent.load('grpc', config)
                .then(() => {
                  grpc = require(`../../../versions/${pkg}@${version}`).get()
                })
            })

            after(() => {
              return agent.close({ ritmReset: false })
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

          describe('with a metadata function', () => {
            before(() => {
              const config = {
                client: {
                  metadata: values => values,
                },
                server: false,
              }

              return agent.load('grpc', config)
                .then(() => {
                  grpc = require(`../../../versions/${pkg}@${version}`).get()
                })
            })

            after(() => {
              return agent.close({ ritmReset: false })
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
          })

          describe('with a metadata array', () => {
            before(() => {
              const config = {
                client: {
                  metadata: ['foo'],
                },
                server: false,
              }

              return agent.load('grpc', config)
                .then(() => {
                  grpc = require(`../../../versions/${pkg}@${version}`).get()
                })
            })

            after(() => {
              return agent.close({ ritmReset: false })
            })

            it('should handle request metadata', async () => {
              const client = await buildClient({
                getUnary: (_, callback) => callback(),
              })

              const metadata = new grpc.Metadata()

              metadata.set('foo', 'bar')
              metadata.set('biz', 'baz')

              client.getUnary({ first: 'foobar' }, metadata, () => {})

              return agent.assertFirstTraceSpan({
                meta: {
                  'grpc.method.name': 'getUnary',
                  'grpc.method.service': 'TestService',
                  'grpc.method.path': '/test.TestService/getUnary',
                  'grpc.method.kind': 'unary',
                  'grpc.request.metadata.foo': 'bar',
                  'rpc.service': 'test.TestService',
                  'span.kind': 'client',
                },
              })
            })

            it('should handle response metadata', async () => {
              const client = await buildClient({
                getUnary: (_, callback) => {
                  const metadata = new grpc.Metadata()

                  metadata.set('foo', 'bar')
                  metadata.set('biz', 'baz')

                  callback(null, {}, metadata)
                },
              })

              client.getUnary({ first: 'foobar' }, () => {})

              return agent
                .assertSomeTraces(traces => {
                  assertObjectContains(traces[0][0].meta, {
                    'grpc.method.name': 'getUnary',
                    'grpc.method.service': 'TestService',
                    'grpc.method.path': '/test.TestService/getUnary',
                    'grpc.method.kind': 'unary',
                    'grpc.response.metadata.foo': 'bar',
                    'rpc.service': 'test.TestService',
                    'span.kind': 'client',
                  })

                  assertObjectContains(traces[0][0].metrics, {
                    'grpc.status.code': 0,
                  })
                })
            })
          })
        })
      }
    })
  })
})
