'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const getPort = require('get-port')
const plugin = require('../src/client')
const Readable = require('stream').Readable

wrapIt()

describe('Plugin', () => {
  let grpc
  let port
  let server

  function buildClient (service) {
    service = Object.assign({
      getBidi: () => {},
      getStream: () => {},
      getUnary: () => {}
    }, service)

    const loader = require('../../../versions/@grpc/proto-loader').get()
    const definition = loader.loadSync(`${__dirname}/test.proto`)
    const TestService = grpc.loadPackageDefinition(definition).TestService

    server = new grpc.Server()

    server.bind(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure())
    server.addService(TestService.service, service)
    server.start()

    return new TestService(`localhost:${port}`, grpc.credentials.createInsecure())
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
              grpc = require(`../../../versions/grpc@${version}`).get()
            })
        })

        after(() => {
          agent.close()
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
                resource: '/TestService/getUnary',
                meta: {
                  'grpc.method.name': 'getUnary',
                  'grpc.method.service': 'TestService',
                  'grpc.method.path': '/TestService/getUnary',
                  'grpc.method.type': 'unary',
                  'grpc.status.code': '0',
                  'span.kind': 'client'
                }
              })
            })
            .then(done)
            .catch(done)

          client.getUnary({ first: 'foobar' }, () => {})
        })

        it('should handle `stream` calls', done => {
          const client = buildClient({
            getStream: stream => stream.end()
          })

          agent
            .use(traces => {
              expect(traces[0][0]).to.deep.include({
                name: 'grpc.request',
                service: 'test-grpc-client',
                resource: '/TestService/getStream',
                meta: {
                  'grpc.method.name': 'getStream',
                  'grpc.method.service': 'TestService',
                  'grpc.method.path': '/TestService/getStream',
                  'grpc.method.type': 'server_stream',
                  'grpc.status.code': '0',
                  'span.kind': 'client'
                }
              })
            })
            .then(done)
            .catch(done)

          client.getStream({ first: 'foobar' }, () => {})
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
                resource: '/TestService/getBidi'
              })
              expect(traces[0][0].meta).to.have.property('grpc.method.name', 'getBidi')
              expect(traces[0][0].meta).to.have.property('grpc.method.service', 'TestService')
              expect(traces[0][0].meta).to.have.property('grpc.method.path', '/TestService/getBidi')
              expect(traces[0][0].meta).to.have.property('grpc.method.type', 'bidi')
              expect(traces[0][0].meta).to.have.property('grpc.status.code', '0')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
            })
            .then(done)
            .catch(done)

          client.getBidi(new Readable(), () => {})
        })

        it('should handle cancelled `unary` calls', done => {
          let call // eslint-disable-line prefer-const
          const client = buildClient({
            getUnary: () => call.cancel()
          })

          agent
            .use(traces => {
              expect(traces[0][0].meta).to.have.property('grpc.status.code', '1')
            })
            .then(done)
            .catch(done)

          call = client.getUnary({ first: 'foobar' }, () => {})
        })

        it('should handle cancelled `stream` calls', done => {
          let call // eslint-disable-line prefer-const
          const client = buildClient({
            getStream: () => call.cancel()
          })

          agent
            .use(traces => {
              expect(traces[0][0].meta).to.have.property('grpc.status.code', '1')
            })
            .then(done)
            .catch(done)

          call = client.getStream({ first: 'foobar' }, () => {})
        })

        it('should handle cancelled `bidi` calls', done => {
          let call // eslint-disable-line prefer-const
          const client = buildClient({
            getBidi: () => call.cancel()
          })

          agent
            .use(traces => {
              expect(traces[0][0].meta).to.have.property('grpc.status.code', '1')
            })
            .then(done)
            .catch(done)

          call = client.getBidi(new Readable(), () => {})
        })

        it('should handle errors', done => {
          const client = buildClient({
            getUnary: (_, callback) => callback(new Error('foobar'))
          })

          agent
            .use(traces => {
              expect(traces[0][0]).to.deep.include({
                error: 1,
                meta: {
                  'error.msg': 'foobar',
                  'error.type': 'Error',
                  'grpc.method.name': 'getUnary',
                  'grpc.method.service': 'TestService',
                  'grpc.method.path': '/TestService/getUnary',
                  'grpc.method.type': 'unary',
                  'grpc.status.code': '2',
                  'span.kind': 'client'
                }
              })
            })
            .then(done)
            .catch(done)

          client.getUnary({ first: 'foobar' }, () => {})
        })

        it('should inject its parent span in the metadata', done => {
          const client = buildClient({
            getUnary: (call, callback) => {
              const metadata = call.metadata.getMap()

              expect(metadata['x-datadog-trace-id']).to.be.a('string')
              expect(metadata['x-datadog-parent-id']).to.be.a('string')

              callback()
            }
          })

          client.getUnary({ first: 'foobar' }, done)
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
          agent.close()
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

      describe('with a fields function', () => {
        before(() => {
          const config = {
            client: {
              fields: values => Object.assign({ extra: 'field' }, values)
            },
            server: false
          }

          return agent.load(plugin, 'grpc', config)
            .then(() => {
              grpc = require(`../../../versions/grpc@${version}`).get()
            })
        })

        after(() => {
          agent.close()
        })

        it('should handle a fields function', done => {
          const client = buildClient({
            getUnary: (_, callback) => callback()
          })

          agent
            .use(traces => {
              expect(traces[0][0].meta).to.have.property('grpc.request.message.fields.extra', 'field')
              expect(traces[0][0].meta).to.have.property('grpc.request.message.fields.first', 'foobar')
            })
            .then(done)
            .catch(done)

          client.getUnary({ first: 'foobar' }, () => {})
        })
      })

      describe('with a fields array', () => {
        before(() => {
          const config = {
            client: {
              fields: ['second']
            },
            server: false
          }

          return agent.load(plugin, 'grpc', config)
            .then(() => {
              grpc = require(`../../../versions/grpc@${version}`).get()
            })
        })

        after(() => {
          agent.close()
        })

        it('should handle a fields array', done => {
          const client = buildClient({
            getUnary: (_, callback) => callback()
          })

          agent
            .use(traces => {
              expect(traces[0][0].meta).to.have.property('grpc.request.message.fields.second', '10')
            })
            .then(done)
            .catch(done)

          client.getUnary({ first: 'foobar', second: 10 }, () => {})
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
          agent.close()
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
          agent.close()
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
                'grpc.method.path': '/TestService/getUnary',
                'grpc.method.type': 'unary',
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
                'grpc.method.path': '/TestService/getUnary',
                'grpc.method.type': 'unary',
                'grpc.response.metadata.foo': 'bar',
                'grpc.status.code': '0',
                'span.kind': 'client'
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
