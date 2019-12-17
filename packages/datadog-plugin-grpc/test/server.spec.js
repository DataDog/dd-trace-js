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

  function buildClient (service) {
    service = Object.assign({
      getBidi: () => {},
      getServerStream: () => {},
      getClientStream: () => {},
      getUnary: () => {}
    }, service)

    const loader = require('../../../versions/@grpc/proto-loader').get()
    const definition = loader.loadSync(`${__dirname}/test.proto`)
    const TestService = grpc.loadPackageDefinition(definition).test.TestService

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
                service: 'test',
                resource: '/test.TestService/getUnary'
              })
              expect(traces[0][0].meta).to.have.property('grpc.method.name', 'getUnary')
              expect(traces[0][0].meta).to.have.property('grpc.method.service', 'TestService')
              expect(traces[0][0].meta).to.have.property('grpc.method.package', 'test')
              expect(traces[0][0].meta).to.have.property('grpc.method.path', '/test.TestService/getUnary')
              expect(traces[0][0].meta).to.have.property('grpc.method.kind', kinds.unary)
              expect(traces[0][0].meta).to.have.property('span.kind', 'server')
              expect(traces[0][0].meta).to.have.property('component', 'grpc')
              expect(traces[0][0].metrics).to.have.property('grpc.status.code', 0)
            })
            .then(done)
            .catch(done)

          client.getUnary({ first: 'foobar' }, () => {})
        })

        it('should handle `stream` calls', done => {
          const client = buildClient({
            getServerStream: stream => stream.end()
          })

          agent
            .use(traces => {
              expect(traces[0][0]).to.deep.include({
                name: 'grpc.request',
                service: 'test',
                resource: '/test.TestService/getServerStream'
              })
              expect(traces[0][0].meta).to.have.property('grpc.method.name', 'getServerStream')
              expect(traces[0][0].meta).to.have.property('grpc.method.service', 'TestService')
              expect(traces[0][0].meta).to.have.property('grpc.method.path', '/test.TestService/getServerStream')
              expect(traces[0][0].meta).to.have.property('grpc.method.kind', kinds.server_stream)
              expect(traces[0][0].meta).to.have.property('span.kind', 'server')
              expect(traces[0][0].metrics).to.have.property('grpc.status.code', 0)
            })
            .then(done)
            .catch(done)

          client.getServerStream({ first: 'foobar' }, () => {})
        })

        it('should handle `bidi` calls', done => {
          const client = buildClient({
            getBidi: stream => stream.end()
          })

          agent
            .use(traces => {
              expect(traces[0][0]).to.deep.include({
                name: 'grpc.request',
                service: 'test',
                resource: '/test.TestService/get_Bidi'
              })
              expect(traces[0][0].meta).to.have.property('grpc.method.name', 'get_Bidi')
              expect(traces[0][0].meta).to.have.property('grpc.method.service', 'TestService')
              expect(traces[0][0].meta).to.have.property('grpc.method.path', '/test.TestService/get_Bidi')
              expect(traces[0][0].meta).to.have.property('grpc.method.kind', kinds.bidi)
              expect(traces[0][0].meta).to.have.property('span.kind', 'server')
              expect(traces[0][0].metrics).to.have.property('grpc.status.code', 0)
            })
            .then(done)
            .catch(done)

          client.getBidi(new Readable(), () => {})
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

          call = client.getServerStream({ first: 'foobar' }, () => {})
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
              expect(traces[0][0].metrics).to.have.property('grpc.status.code', 5)
            })
            .then(done)
            .catch(done)

          client.getUnary({ first: 'foobar' }, () => {})
        })

        it('should handle stream errors', done => {
          let error = null

          const client = buildClient({
            getBidi: (stream) => {
              error = new Error('foobar')
              error.code = grpc.status.NOT_FOUND

              stream.emit('error', error)
            }
          })

          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.have.property('error.msg', 'foobar')
              expect(traces[0][0].meta['error.stack']).to.equal(error.stack)
              expect(traces[0][0].meta).to.have.property('error.type', 'Error')
              expect(traces[0][0].metrics).to.have.property('grpc.status.code', 5)
            })
            .then(done)
            .catch(done)

          client.getBidi(new Readable(), () => {})
        })

        it('should run the handler in the scope of the request', done => {
          const client = buildClient({
            getUnary: (_, callback) => {
              try {
                callback()
                expect(tracer.scope().active()).to.not.be.null
                done()
              } catch (e) {
                done(e)
              }
            }
          })

          client.getUnary({ first: 'foobar' }, () => {})
        })

        it('should run the emitter in the scope of the caller', done => {
          let emitter = null

          const client = buildClient({
            getUnary: (call, callback) => {
              const span = tracer.scope().active()

              emitter = call
              emitter.on('test', () => {
                expect(tracer.scope().active()).to.equal(span)
                expect(span).to.not.be.null
                done()
              })

              callback(null, {})
            }
          })

          client.getUnary({ first: 'foobar' }, () => {
            emitter.emit('test')
          })
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

        it('should not alter the request metadata', done => {
          const client = buildClient({
            getUnary: (call, callback) => {
              callback(null, {})

              try {
                expect(call.metadata.getMap()).to.have.property('foo', 'bar')
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
      })
    })
  })
})
