'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const getPort = require('get-port')
const plugin = require('../src/client')
const Readable = require('stream').Readable
const kinds = require('../src/kinds')

wrapIt()

describe('Plugin', () => {
  let grpc
  let port
  let server
  let tracer
  let loader

  function buildClient (service, ClientService) {
    service = Object.assign({
      getBidi: () => {},
      getServerStream: () => {},
      getClientStream: () => {},
      getUnary: () => {}
    }, service)

    loader = require('../../../versions/@grpc/proto-loader').get()

    const definition = loader.loadSync(`${__dirname}/test.proto`)
    const TestService = grpc.loadPackageDefinition(definition).test.TestService

    server = new grpc.Server()

    server.bind(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure())
    server.addService(TestService.service, service)
    server.start()

    ClientService = ClientService || TestService

    return new ClientService(`localhost:${port}`, grpc.credentials.createInsecure())
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

    withVersions(plugin, 'grpc', version => {
      describe('without configuration', () => {
        before(() => {
          return agent.load(plugin, 'grpc', { server: false })
            .then(() => {
              tracer = require('../../dd-trace')
              grpc = require(`../../../versions/grpc@${version}`).get()
            })
        })

        after(() => {
          return agent.close()
        })

        it('should handle `unary` calls', done => {
          const client = buildClient({
            getUnary: (_, callback) => callback()
          })

          agent
            .use(traces => {
              expect(traces[0][0]).to.deep.include({
                name: 'grpc.request',
                service: 'test-grpc-client',
                resource: '/test.TestService/getUnary',
                meta: {
                  'grpc.method.name': 'getUnary',
                  'grpc.method.service': 'TestService',
                  'grpc.method.package': 'test',
                  'grpc.method.path': '/test.TestService/getUnary',
                  'grpc.method.kind': kinds.unary,
                  'span.kind': 'client',
                  'component': 'grpc'
                }
              })

              expect(traces[0][0].metrics).to.include({
                'grpc.status.code': 0
              })
            })
            .then(done)
            .catch(done)

          client.getUnary({ first: 'foobar' }, () => {})
        })

        it('should handle `server_stream` calls', done => {
          const client = buildClient({
            getServerStream: stream => {
              stream.end()
            }
          })

          agent
            .use(traces => {
              expect(traces[0][0]).to.deep.include({
                name: 'grpc.request',
                service: 'test-grpc-client',
                resource: '/test.TestService/getServerStream',
                meta: {
                  'grpc.method.name': 'getServerStream',
                  'grpc.method.service': 'TestService',
                  'grpc.method.package': 'test',
                  'grpc.method.path': '/test.TestService/getServerStream',
                  'grpc.method.kind': kinds.server_stream,
                  'span.kind': 'client',
                  'component': 'grpc'
                }
              })

              expect(traces[0][0].metrics).to.include({
                'grpc.status.code': 0
              })
            })
            .then(done)
            .catch(done)

          const call = client.getServerStream({ first: 'foobar' })

          call.on('data', () => {})
        })

        it('should handle `client_stream` calls', done => {
          const client = buildClient({
            getClientStream: (_, callback) => {
              callback()
            }
          })

          agent
            .use(traces => {
              expect(traces[0][0]).to.deep.include({
                name: 'grpc.request',
                service: 'test-grpc-client',
                resource: '/test.TestService/getClientStream',
                meta: {
                  'grpc.method.name': 'getClientStream',
                  'grpc.method.service': 'TestService',
                  'grpc.method.package': 'test',
                  'grpc.method.path': '/test.TestService/getClientStream',
                  'grpc.method.kind': kinds.client_stream,
                  'span.kind': 'client',
                  'component': 'grpc'
                }
              })

              expect(traces[0][0].metrics).to.include({
                'grpc.status.code': 0
              })
            })
            .then(done)
            .catch(done)

          client.getClientStream(() => {})
        })

        it('should handle `bidi` calls', done => {
          const client = buildClient({
            getBidi: stream => stream.end()
          })

          agent
            .use(traces => {
              expect(traces[0][0]).to.deep.include({
                name: 'grpc.request',
                service: 'test-grpc-client',
                resource: '/test.TestService/get_Bidi'
              })
              expect(traces[0][0].meta).to.have.property('grpc.method.name', 'get_Bidi')
              expect(traces[0][0].meta).to.have.property('grpc.method.service', 'TestService')
              expect(traces[0][0].meta).to.have.property('grpc.method.path', '/test.TestService/get_Bidi')
              expect(traces[0][0].meta).to.have.property('grpc.method.kind', kinds.bidi)
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].metrics).to.have.property('grpc.status.code', 0)
            })
            .then(done)
            .catch(done)

          const call = client.getBidi(new Readable())

          call.on('data', () => {})
        })

        it('should handle cancelled `unary` calls', done => {
          let call = null
          const client = buildClient({
            getUnary: () => call.cancel()
          })

          agent
            .use(traces => {
              expect(traces[0][0].metrics).to.have.property('grpc.status.code', 1)
            })
            .then(done)
            .catch(done)

          call = client.getUnary({ first: 'foobar' }, () => {})
        })

        it('should handle cancelled `stream` calls', done => {
          let call = null
          const client = buildClient({
            getServerStream: () => call.cancel()
          })

          agent
            .use(traces => {
              expect(traces[0][0].metrics).to.have.property('grpc.status.code', 1)
            })
            .then(done)
            .catch(done)

          call = client.getServerStream({ first: 'foobar' })
          call.on('data', () => {})
          call.on('error', () => {})
        })

        it('should handle cancelled `bidi` calls', done => {
          let call = null
          const client = buildClient({
            getBidi: () => call.cancel()
          })

          agent
            .use(traces => {
              expect(traces[0][0].metrics).to.have.property('grpc.status.code', 1)
            })
            .then(done)
            .catch(done)

          call = client.getBidi(new Readable(), () => {})
          call.on('data', () => {})
          call.on('error', () => {})
        })

        it('should handle errors', done => {
          const client = buildClient({
            getUnary: (_, callback) => callback(new Error('foobar'))
          })

          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.include({
                'error.msg': '2 UNKNOWN: foobar',
                'error.type': 'Error',
                'grpc.method.name': 'getUnary',
                'grpc.method.service': 'TestService',
                'grpc.method.package': 'test',
                'grpc.method.path': '/test.TestService/getUnary',
                'grpc.method.kind': kinds.unary,
                'span.kind': 'client',
                'component': 'grpc'
              })
              expect(traces[0][0].meta).to.have.property('error.stack')
              expect(traces[0][0].metrics).to.have.property('grpc.status.code', 2)
            })
            .then(done)
            .catch(done)

          client.getUnary({ first: 'foobar' }, () => {})
        })

        it('should handle protocol errors', done => {
          const definition = loader.loadSync(`${__dirname}/invalid.proto`)
          const test = grpc.loadPackageDefinition(definition).test
          const client = buildClient({
            getUnary: (_, callback) => callback(null)
          }, test.TestService)

          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.include({
                'error.msg': '13 INTERNAL: Failed to parse server response',
                'error.type': 'Error',
                'grpc.method.name': 'getUnary',
                'grpc.method.service': 'TestService',
                'grpc.method.package': 'test',
                'grpc.method.path': '/test.TestService/getUnary',
                'grpc.method.kind': kinds.unary,
                'span.kind': 'client',
                'component': 'grpc'
              })
              expect(traces[0][0].meta).to.have.property('error.stack')
              expect(traces[0][0].metrics).to.have.property('grpc.status.code', 13)
            })
            .then(done)
            .catch(done)

          client.getUnary({ first: 'foobar' }, () => {})
        })

        it('should handle a missing callback', done => {
          const client = buildClient({
            getUnary: (_, callback) => callback()
          })

          agent
            .use(traces => {
              expect(traces[0][0]).to.deep.include({
                name: 'grpc.request',
                service: 'test-grpc-client',
                resource: '/test.TestService/getUnary',
                meta: {
                  'grpc.method.name': 'getUnary',
                  'grpc.method.service': 'TestService',
                  'grpc.method.package': 'test',
                  'grpc.method.path': '/test.TestService/getUnary',
                  'grpc.method.kind': kinds.unary,
                  'span.kind': 'client',
                  'component': 'grpc'
                }
              })

              expect(traces[0][0].metrics).to.deep.include({
                'grpc.status.code': 0
              })
            })
            .then(done)
            .catch(done)

          client.getUnary({ first: 'foobar' })
        })

        it('should inject its parent span in the metadata', done => {
          const client = buildClient({
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
          })

          const metadata = new grpc.Metadata()

          metadata.set('foo', 'bar')

          client.getUnary({ first: 'foobar' }, metadata, () => {})
        })

        it('should propagate the parent scope to the callback', done => {
          const span = {}
          const client = buildClient({
            getUnary: (call, callback) => callback()
          })

          tracer.scope().activate(span, () => {
            client.getUnary({ first: 'foobar' }, (err, response) => {
              expect(tracer.scope().active()).to.equal(span)
              done(err)
            })
          })
        })

        it('should propagate the parent scope to event listeners', done => {
          const span = {}
          const client = buildClient({
            getServerStream: stream => {
              stream.write('test')
              stream.end()
            }
          })

          const call = client.getServerStream({ first: 'foobar' })

          tracer.scope().activate(span, () => {
            call.on('data', () => {
              expect(tracer.scope().active()).to.equal(span)
              done()
            })
          })
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

          return agent.load(plugin, 'grpc', config)
            .then(() => {
              grpc = require(`../../../versions/grpc@${version}`).get()
            })
        })

        after(() => {
          return agent.close()
        })

        it('should be configured with the correct values', done => {
          const client = buildClient({
            getUnary: (_, callback) => callback()
          })

          agent
            .use(traces => {
              expect(traces[0][0]).to.deep.include({
                service: 'custom'
              })
            })
            .then(done)
            .catch(done)

          client.getUnary({ first: 'foobar' }, () => {})
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

          return agent.load(plugin, 'grpc', config)
            .then(() => {
              grpc = require(`../../../versions/grpc@${version}`).get()
            })
        })

        after(() => {
          return agent.close()
        })

        it('should handle request metadata', done => {
          const client = buildClient({
            getUnary: (_, callback) => callback()
          })

          agent
            .use(traces => {
              expect(traces[0][0].meta).to.have.property('grpc.request.metadata.foo', 'bar')
            })
            .then(done)
            .catch(done)

          const metadata = new grpc.Metadata()

          metadata.set('foo', 'bar')

          client.getUnary({ first: 'foobar' }, metadata, () => {})
        })

        it('should handle response metadata', done => {
          const client = buildClient({
            getUnary: (_, callback) => {
              const metadata = new grpc.Metadata()

              metadata.set('foo', 'bar')

              callback(null, {}, metadata)
            }
          })

          agent
            .use(traces => {
              expect(traces[0][0].meta).to.have.property('grpc.response.metadata.foo', 'bar')
            })
            .then(done)
            .catch(done)

          client.getUnary({ first: 'foobar' }, () => {})
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

          return agent.load(plugin, 'grpc', config)
            .then(() => {
              grpc = require(`../../../versions/grpc@${version}`).get()
            })
        })

        after(() => {
          return agent.close()
        })

        it('should handle request metadata', done => {
          const client = buildClient({
            getUnary: (_, callback) => callback()
          })

          agent
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
            .then(done)
            .catch(done)

          const metadata = new grpc.Metadata()

          metadata.set('foo', 'bar')
          metadata.set('biz', 'baz')

          client.getUnary({ first: 'foobar' }, metadata, () => {})
        })

        it('should handle response metadata', done => {
          const client = buildClient({
            getUnary: (_, callback) => {
              const metadata = new grpc.Metadata()

              metadata.set('foo', 'bar')
              metadata.set('biz', 'baz')

              callback(null, {}, metadata)
            }
          })

          agent
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
            .then(done)
            .catch(done)

          client.getUnary({ first: 'foobar' }, () => {})
        })
      })
    })
  })
})
