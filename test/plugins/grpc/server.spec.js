'use strict'

const agent = require('../agent')
const getPort = require('get-port')
const plugin = require('../../../src/plugins/grpc/client')
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

  describe('grpc/server', () => {
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
          return agent.load(plugin, 'grpc', { client: false })
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
                service: 'test-grpc-server',
                resource: '/TestService/getUnary'
              })
              expect(traces[0][0].meta).to.have.property('grpc.method.name', 'getUnary')
              expect(traces[0][0].meta).to.have.property('grpc.method.service', 'TestService')
              expect(traces[0][0].meta).to.have.property('grpc.method.path', '/TestService/getUnary')
              expect(traces[0][0].meta).to.have.property('grpc.method.type', 'unary')
              expect(traces[0][0].meta).to.have.property('grpc.status.code', '0')
              expect(traces[0][0].meta).to.have.property('span.kind', 'server')
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
                service: 'test-grpc-server',
                resource: '/TestService/getStream'
              })
              expect(traces[0][0].meta).to.have.property('grpc.method.name', 'getStream')
              expect(traces[0][0].meta).to.have.property('grpc.method.service', 'TestService')
              expect(traces[0][0].meta).to.have.property('grpc.method.path', '/TestService/getStream')
              expect(traces[0][0].meta).to.have.property('grpc.method.type', 'server_stream')
              expect(traces[0][0].meta).to.have.property('grpc.status.code', '0')
              expect(traces[0][0].meta).to.have.property('span.kind', 'server')
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
                service: 'test-grpc-server',
                resource: '/TestService/getBidi'
              })
              expect(traces[0][0].meta).to.have.property('grpc.method.name', 'getBidi')
              expect(traces[0][0].meta).to.have.property('grpc.method.service', 'TestService')
              expect(traces[0][0].meta).to.have.property('grpc.method.path', '/TestService/getBidi')
              expect(traces[0][0].meta).to.have.property('grpc.method.type', 'bidi')
              expect(traces[0][0].meta).to.have.property('grpc.status.code', '0')
              expect(traces[0][0].meta).to.have.property('span.kind', 'server')
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

        it('should handle errors without `code`', done => {
          const client = buildClient({
            getUnary: (_, callback) => {
              const metadata = new grpc.Metadata()

              metadata.set('extra', 'information')

              callback(new Error('foobar'), {}, metadata)
            }
          })

          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.have.property('error.msg', 'foobar')
              expect(traces[0][0].meta['error.stack']).to.match(/^Error: foobar\n {4}at Object.getUnary.*/)
              expect(traces[0][0].meta).to.have.property('error.type', 'Error')
              expect(traces[0][0].meta).to.not.have.property('grpc.status.code')
            })
            .then(done)
            .catch(done)

          client.getUnary({ first: 'foobar' }, () => {})
        })

        it('should handle errors with `code`', done => {
          const client = buildClient({
            getUnary: (_, callback) => {
              const metadata = new grpc.Metadata()

              metadata.set('extra', 'information')

              const error = new Error('foobar')

              error.code = grpc.status.NOT_FOUND

              callback(error, {}, metadata)
            }
          })

          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.have.property('error.msg', 'foobar')
              expect(traces[0][0].meta['error.stack']).to.match(/^Error: foobar\n {4}at Object.getUnary.*/)
              expect(traces[0][0].meta).to.have.property('error.type', 'Error')
              expect(traces[0][0].meta).to.have.property('grpc.status.code', '5')
            })
            .then(done)
            .catch(done)

          client.getUnary({ first: 'foobar' }, () => {})
        })
      })

      describe('with service configuration', () => {
        before(() => {
          const config = {
            server: {
              service: 'custom'
            },
            client: false
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

      describe('with fields configuration', () => {
        before(() => {
          const config = {
            server: {
              fields: values => Object.assign({ extra: 'field' }, values)
            },
            client: false
          }

          return agent.load(plugin, 'grpc', config)
            .then(() => {
              grpc = require(`../../../versions/grpc@${version}`).get()
            })
        })

        after(() => {
          agent.close()
        })

        it('should call the fields function', done => {
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

      describe('with metadata configuration', () => {
        before(() => {
          const config = {
            server: {
              metadata: values => values
            },
            client: false
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
    })
  })
})
