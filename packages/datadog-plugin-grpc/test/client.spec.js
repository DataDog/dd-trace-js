'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const getPort = require('get-port')
const Readable = require('stream').Readable
const getService = require('./service')
const loader = require('../../../versions/@grpc/proto-loader').get()
const pkgs = ['grpc', '@grpc/grpc-js']

describe('Plugin', () => {
  let grpc
  let port
  let server
  let tracer

  const clientBuilders = {
    protobuf: buildProtoClient,
    custom: buildCustomClient
  }

  function buildGenericService (service, TestService, ClientService) {
    service = Object.assign({
      getBidi: () => {},
      getServerStream: () => {},
      getClientStream: () => {},
      getUnary: () => {}
    }, service)

    server = new grpc.Server()

    return new Promise((resolve, reject) => {
      ClientService = ClientService || TestService

      if (server.bindAsync) {
        server.bindAsync(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
          if (err) return reject(err)

          server.addService(TestService.service, service)
          server.start()

          resolve(new ClientService(`localhost:${port}`, grpc.credentials.createInsecure()))
        })
      } else {
        server.bind(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure())
        server.addService(TestService.service, service)
        server.start()

        resolve(new ClientService(`localhost:${port}`, grpc.credentials.createInsecure()))
      }
    })
  }

  function buildProtoClient (service, ClientService) {
    const definition = loader.loadSync(`${__dirname}/test.proto`)
    const TestService = grpc.loadPackageDefinition(definition).test.TestService

    return buildGenericService(service, TestService, ClientService)
  }

  function buildCustomClient (service, ClientService) {
    const TestService = getService(grpc)

    return buildGenericService(service, TestService, ClientService)
  }

  describe('grpc/client', () => {
    beforeEach(() => {
      return getPort().then(newPort => {
        port = newPort
      })
    })

    afterEach(() => {
      server.forceShutdown()
    })

    withVersions('grpc', pkgs, (version, pkg) => {
      for (const clientName in clientBuilders) {
        const buildClient = clientBuilders[clientName]

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

            it('should handle `unary` calls', async () => {
              const client = await buildClient({
                getUnary: (_, callback) => callback()
              })

              client.getUnary({ first: 'foobar' }, () => {})

              return agent
                .use(traces => {
                  expect(traces[0][0]).to.deep.include({
                    name: 'grpc.client',
                    service: 'test',
                    resource: '/test.TestService/getUnary',
                    type: 'http'
                  })

                  expect(traces[0][0].meta).to.include({
                    'grpc.method.name': 'getUnary',
                    'grpc.method.service': 'TestService',
                    'grpc.method.package': 'test',
                    'grpc.method.path': '/test.TestService/getUnary',
                    'grpc.method.kind': 'unary',
                    'span.kind': 'client',
                    'component': 'grpc'
                  })

                  expect(traces[0][0].metrics).to.include({
                    'grpc.status.code': 0
                  })
                })
            })

            it('should handle `server_stream` calls', async () => {
              const client = await buildClient({
                getServerStream: stream => {
                  stream.end()
                }
              })

              const call = client.getServerStream({ first: 'foobar' })

              call.on('data', () => {})

              return agent
                .use(traces => {
                  expect(traces[0][0]).to.deep.include({
                    name: 'grpc.client',
                    service: 'test',
                    resource: '/test.TestService/getServerStream',
                    type: 'http'
                  })

                  expect(traces[0][0].meta).to.include({
                    'grpc.method.name': 'getServerStream',
                    'grpc.method.service': 'TestService',
                    'grpc.method.package': 'test',
                    'grpc.method.path': '/test.TestService/getServerStream',
                    'grpc.method.kind': 'server_streaming',
                    'span.kind': 'client',
                    'component': 'grpc'
                  })

                  expect(traces[0][0].metrics).to.include({
                    'grpc.status.code': 0
                  })
                })
            })

            it('should handle `client_stream` calls', async () => {
              const client = await buildClient({
                getClientStream: (_, callback) => {
                  setTimeout(callback, 40)
                }
              })

              client.getClientStream(() => {})

              return agent
                .use(traces => {
                  expect(traces[0][0]).to.deep.include({
                    name: 'grpc.client',
                    service: 'test',
                    resource: '/test.TestService/getClientStream',
                    type: 'http'
                  })

                  expect(traces[0][0].meta).to.include({
                    'grpc.method.name': 'getClientStream',
                    'grpc.method.service': 'TestService',
                    'grpc.method.package': 'test',
                    'grpc.method.path': '/test.TestService/getClientStream',
                    'grpc.method.kind': 'client_streaming',
                    'span.kind': 'client',
                    'component': 'grpc'
                  })

                  expect(traces[0][0].metrics).to.include({
                    'grpc.status.code': 0
                  })
                })
            })

            it('should handle `bidi` calls', async () => {
              const client = await buildClient({
                getBidi: stream => stream.end()
              })

              const call = client.getBidi(new Readable())

              call.on('data', () => {})

              return agent
                .use(traces => {
                  expect(traces[0][0]).to.deep.include({
                    name: 'grpc.client',
                    service: 'test',
                    resource: '/test.TestService/getBidi',
                    type: 'http'
                  })
                  expect(traces[0][0].meta).to.have.property('grpc.method.name', 'getBidi')
                  expect(traces[0][0].meta).to.have.property('grpc.method.service', 'TestService')
                  expect(traces[0][0].meta).to.have.property('grpc.method.path', '/test.TestService/getBidi')
                  expect(traces[0][0].meta).to.have.property('grpc.method.kind', 'bidi_streaming')
                  expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                  expect(traces[0][0].metrics).to.have.property('grpc.status.code', 0)
                })
            })

            it('should handle cancelled `unary` calls', async () => {
              let call = null
              const client = await buildClient({
                getUnary: () => call.cancel()
              })

              call = client.getUnary({ first: 'foobar' }, () => {})

              return agent
                .use(traces => {
                  expect(traces[0][0].metrics).to.have.property('grpc.status.code', 1)
                })
            })

            it('should handle cancelled `stream` calls', async () => {
              let call = null
              const client = await buildClient({
                getServerStream: () => call.cancel()
              })

              call = client.getServerStream({ first: 'foobar' })
              call.on('data', () => {})
              call.on('error', () => {})

              return agent
                .use(traces => {
                  expect(traces[0][0].metrics).to.have.property('grpc.status.code', 1)
                })
            })

            it('should handle cancelled `bidi` calls', async () => {
              let call = null
              const client = await buildClient({
                getBidi: () => call.cancel()
              })

              call = client.getBidi(new Readable(), () => {})
              call.on('data', () => {})
              call.on('error', () => {})

              return agent
                .use(traces => {
                  expect(traces[0][0].metrics).to.have.property('grpc.status.code', 1)
                })
            })

            it('should handle errors', async () => {
              const client = await buildClient({
                getUnary: (_, callback) => callback(new Error('foobar'))
              })

              client.getUnary({ first: 'foobar' }, () => {})

              return agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('error', 1)
                  expect(traces[0][0].meta).to.include({
                    'error.msg': '2 UNKNOWN: foobar',
                    'error.type': 'Error',
                    'grpc.method.name': 'getUnary',
                    'grpc.method.service': 'TestService',
                    'grpc.method.package': 'test',
                    'grpc.method.path': '/test.TestService/getUnary',
                    'grpc.method.kind': 'unary',
                    'span.kind': 'client',
                    'component': 'grpc'
                  })
                  expect(traces[0][0].meta).to.have.property('error.stack')
                  expect(traces[0][0].metrics).to.have.property('grpc.status.code', 2)
                })
            })

            it('should handle protocol errors', async () => {
              const definition = loader.loadSync(`${__dirname}/invalid.proto`)
              const test = grpc.loadPackageDefinition(definition).test
              const client = await buildClient({
                getUnary: (_, callback) => callback(null)
              }, test.TestService)

              client.getUnary({ first: 'foobar' }, () => {})

              return agent
                .use(traces => {
                  expect(traces[0][0]).to.have.property('error', 1)
                  expect(traces[0][0].meta).to.include({
                    'error.type': 'Error',
                    'grpc.method.name': 'getUnary',
                    'grpc.method.service': 'TestService',
                    'grpc.method.package': 'test',
                    'grpc.method.path': '/test.TestService/getUnary',
                    'grpc.method.kind': 'unary',
                    'span.kind': 'client',
                    'component': 'grpc'
                  })
                  expect(traces[0][0].meta).to.have.property('error.stack')
                  expect(traces[0][0].meta['error.msg']).to.match(/^13 INTERNAL:.+$/)
                  expect(traces[0][0].metrics).to.have.property('grpc.status.code', 13)
                })
            })

            it('should handle property named "service"', async () => {
              const definition = loader.loadSync(`${__dirname}/hasservice.proto`)
              const thing = grpc.loadPackageDefinition(definition).thing
              await buildClient({
                getUnary: (_, callback) => callback(null)
              }, thing.service.ThingService)
            })

            it('should handle a missing callback', async () => {
              const client = await buildClient({
                getUnary: (_, callback) => callback()
              })

              client.getUnary({ first: 'foobar' })

              return agent
                .use(traces => {
                  expect(traces[0][0]).to.deep.include({
                    name: 'grpc.client',
                    service: 'test',
                    resource: '/test.TestService/getUnary'
                  })

                  expect(traces[0][0].meta).to.include({
                    'grpc.method.name': 'getUnary',
                    'grpc.method.service': 'TestService',
                    'grpc.method.package': 'test',
                    'grpc.method.path': '/test.TestService/getUnary',
                    'grpc.method.kind': 'unary',
                    'span.kind': 'client',
                    'component': 'grpc'
                  })

                  expect(traces[0][0].metrics).to.deep.include({
                    'grpc.status.code': 0
                  })
                })
            })

            it('should handle undefined metadata', async () => {
              const client = await buildClient({
                getUnary: (_, callback) => callback()
              })

              client.getUnary({ first: 'foobar' }, undefined, () => {})

              return agent
                .use(traces => {
                  expect(traces[0][0]).to.deep.include({
                    name: 'grpc.client',
                    service: 'test',
                    resource: '/test.TestService/getUnary'
                  })

                  expect(traces[0][0].meta).to.include({
                    'grpc.method.name': 'getUnary',
                    'grpc.method.service': 'TestService',
                    'grpc.method.package': 'test',
                    'grpc.method.path': '/test.TestService/getUnary',
                    'grpc.method.kind': 'unary',
                    'span.kind': 'client',
                    'component': 'grpc'
                  })

                  expect(traces[0][0].metrics).to.deep.include({
                    'grpc.status.code': 0
                  })
                })
            })

            it('should inject its parent span in the metadata', done => {
              buildClient({
                getUnary: (call, callback) => {
                  const metadata = call.metadata.getMap()

                  callback(null, {})

                  try {
                    expect(metadata).to.have.property('foo', 'bar')
                    expect(metadata['x-datadog-trace-id']).to.be.a('string')
                    expect(metadata['x-datadog-parent-id']).to.be.a('string')

                    done()
                  } catch (e) {
                    done(e)
                  }
                }
              }).then(client => {
                const metadata = new grpc.Metadata()

                metadata.set('foo', 'bar')

                client.getUnary({ first: 'foobar' }, metadata, () => {})
              }, done)
            })

            it('should propagate the parent scope to the callback', done => {
              const span = {}

              buildClient({
                getUnary: (call, callback) => callback()
              }).then(client => {
                tracer.scope().activate(span, () => {
                  client.getUnary({ first: 'foobar' }, (err, response) => {
                    expect(tracer.scope().active()).to.equal(span)
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
                }
              }).then(client => {
                tracer.scope().activate(span, () => {
                  const call = client.getServerStream({ first: 'foobar' })

                  call.on('data', () => {
                    expect(tracer.scope().active()).to.equal(span)
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
                  service: 'custom'
                },
                server: false
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
                getUnary: (_, callback) => callback()
              })

              client.getUnary({ first: 'foobar' }, () => {})

              return agent
                .use(traces => {
                  expect(traces[0][0]).to.deep.include({
                    service: 'custom'
                  })
                })
            })
          })

          describe('with a metadata function', () => {
            before(() => {
              const config = {
                client: {
                  metadata: values => values
                },
                server: false
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
                getUnary: (_, callback) => callback()
              })

              const metadata = new grpc.Metadata()

              metadata.set('foo', 'bar')

              client.getUnary({ first: 'foobar' }, metadata, () => {})

              return agent
                .use(traces => {
                  expect(traces[0][0].meta).to.have.property('grpc.request.metadata.foo', 'bar')
                })
            })

            it('should handle response metadata', async () => {
              const client = await buildClient({
                getUnary: (_, callback) => {
                  const metadata = new grpc.Metadata()

                  metadata.set('foo', 'bar')

                  callback(null, {}, metadata)
                }
              })

              client.getUnary({ first: 'foobar' }, () => {})

              return agent
                .use(traces => {
                  expect(traces[0][0].meta).to.have.property('grpc.response.metadata.foo', 'bar')
                })
            })
          })

          describe('with a metadata array', () => {
            before(() => {
              const config = {
                client: {
                  metadata: ['foo']
                },
                server: false
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
                getUnary: (_, callback) => callback()
              })

              const metadata = new grpc.Metadata()

              metadata.set('foo', 'bar')
              metadata.set('biz', 'baz')

              client.getUnary({ first: 'foobar' }, metadata, () => {})

              return agent
                .use(traces => {
                  expect(traces[0][0].meta).to.deep.include({
                    'grpc.method.name': 'getUnary',
                    'grpc.method.service': 'TestService',
                    'grpc.method.path': '/test.TestService/getUnary',
                    'grpc.method.kind': 'unary',
                    'grpc.request.metadata.foo': 'bar',
                    'span.kind': 'client'
                  })
                })
            })

            it('should handle response metadata', async () => {
              const client = await buildClient({
                getUnary: (_, callback) => {
                  const metadata = new grpc.Metadata()

                  metadata.set('foo', 'bar')
                  metadata.set('biz', 'baz')

                  callback(null, {}, metadata)
                }
              })

              client.getUnary({ first: 'foobar' }, () => {})

              return agent
                .use(traces => {
                  expect(traces[0][0].meta).to.deep.include({
                    'grpc.method.name': 'getUnary',
                    'grpc.method.service': 'TestService',
                    'grpc.method.path': '/test.TestService/getUnary',
                    'grpc.method.kind': 'unary',
                    'grpc.response.metadata.foo': 'bar',
                    'span.kind': 'client'
                  })

                  expect(traces[0][0].metrics).to.deep.include({
                    'grpc.status.code': 0
                  })
                })
            })
          })
        })
      }
    })
  })
})
