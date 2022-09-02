'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const getPort = require('get-port')
const Readable = require('stream').Readable
const pkgs = ['grpc', '@grpc/grpc-js']

describe('Plugin', () => {
  let grpc
  let port
  let server
  let tracer
  let call

  function buildClient (service, callback) {
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

    return new Promise((resolve, reject) => {
      if (server.bindAsync) {
        server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
          if (err) return reject(err)

          server.addService(TestService.service, service)
          server.start()

          resolve(new TestService(`localhost:${port}`, grpc.credentials.createInsecure()))
        })
      } else {
        server.bind(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure())
        server.addService(TestService.service, service)
        server.start()

        resolve(new TestService(`localhost:${port}`, grpc.credentials.createInsecure()))
      }
    })
  }

  describe('grpc/server', () => {
    beforeEach(() => {
      call = null
      return getPort().then(newPort => {
        port = newPort
      })
    })

    afterEach(() => {
      server.forceShutdown()
    })

    withVersions('grpc', pkgs, (version, pkg) => {
      describe('without configuration', () => {
        before(() => {
          return agent.load('grpc', { client: false })
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
                name: 'grpc.server',
                service: 'test',
                resource: '/test.TestService/getUnary',
                type: 'web'
              })
              expect(traces[0][0].meta).to.have.property('grpc.method.name', 'getUnary')
              expect(traces[0][0].meta).to.have.property('grpc.method.service', 'TestService')
              expect(traces[0][0].meta).to.have.property('grpc.method.package', 'test')
              expect(traces[0][0].meta).to.have.property('grpc.method.path', '/test.TestService/getUnary')
              expect(traces[0][0].meta).to.have.property('grpc.method.kind', 'unary')
              expect(traces[0][0].meta).to.have.property('span.kind', 'server')
              expect(traces[0][0].meta).to.have.property('component', 'grpc')
              expect(traces[0][0].metrics).to.have.property('grpc.status.code', 0)
            })
        })

        it('should handle `stream` calls', async () => {
          const client = await buildClient({
            getServerStream: stream => stream.end()
          })

          client.getServerStream({ first: 'foobar' }, () => {})

          return agent
            .use(traces => {
              expect(traces[0][0]).to.deep.include({
                name: 'grpc.server',
                service: 'test',
                resource: '/test.TestService/getServerStream',
                type: 'web'
              })
              expect(traces[0][0].meta).to.have.property('grpc.method.name', 'getServerStream')
              expect(traces[0][0].meta).to.have.property('grpc.method.service', 'TestService')
              expect(traces[0][0].meta).to.have.property('grpc.method.path', '/test.TestService/getServerStream')
              expect(traces[0][0].meta).to.have.property('grpc.method.kind', 'server_streaming')
              expect(traces[0][0].meta).to.have.property('span.kind', 'server')
              expect(traces[0][0].metrics).to.have.property('grpc.status.code', 0)
            })
        })

        it('should handle `bidi` calls', async () => {
          const client = await buildClient({
            getBidi: stream => stream.end()
          })

          call = client.getBidi(new Readable(), () => {})
          call.on('error', () => {})

          return agent
            .use(traces => {
              expect(traces[0][0]).to.deep.include({
                name: 'grpc.server',
                service: 'test',
                resource: '/test.TestService/getBidi',
                type: 'web'
              })
              expect(traces[0][0].meta).to.have.property('grpc.method.name', 'getBidi')
              expect(traces[0][0].meta).to.have.property('grpc.method.service', 'TestService')
              expect(traces[0][0].meta).to.have.property('grpc.method.path', '/test.TestService/getBidi')
              expect(traces[0][0].meta).to.have.property('grpc.method.kind', 'bidi_streaming')
              expect(traces[0][0].meta).to.have.property('span.kind', 'server')
              expect(traces[0][0].metrics).to.have.property('grpc.status.code', 0)
            })
        })

        it('should handle cancelled `unary` calls', async () => {
          let call = null
          const client = await buildClient({
            getUnary: () => call.cancel()
          })

          call = client.getUnary({ first: 'foobar' }, () => {})
          call.on('error', () => {})

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

          call = client.getServerStream({ first: 'foobar' }, () => {})
          call.on('error', () => {})

          return agent
            .use(traces => {
              expect(traces[0][0].metrics).to.have.property('grpc.status.code', 1)
            })
        })

        it('should handle cancelled `bidi` calls', async () => {
          const client = await buildClient({
            getBidi: () => call.cancel()
          })

          call = client.getBidi(new Readable(), () => {})
          call.on('error', () => {})

          return agent
            .use(traces => {
              expect(traces[0][0].metrics).to.have.property('grpc.status.code', 1)
            })
        })

        it('should handle errors without `code`', async () => {
          const client = await buildClient({
            getUnary: (_, callback) => {
              const metadata = new grpc.Metadata()

              metadata.set('extra', 'information')

              callback(new Error('foobar'), {}, metadata)
            }
          })

          client.getUnary({ first: 'foobar' }, () => {})

          return agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.have.property('error.msg', 'foobar')
              expect(traces[0][0].meta).to.have.property('error.type', 'Error')
              expect(traces[0][0].meta).to.not.have.property('grpc.status.code')
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
            }
          })

          client.getUnary({ first: 'foobar' }, () => {})

          return agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.have.property('error.msg', 'foobar')
              expect(traces[0][0].meta['error.stack']).to.match(/^Error: foobar\n {4}at Object.getUnary.*/)
              expect(traces[0][0].meta).to.have.property('error.type', 'Error')
              expect(traces[0][0].metrics).to.have.property('grpc.status.code', 5)
            })
        })

        it('should handle stream errors', async () => {
          let error = null

          const client = await buildClient({
            getBidi: (stream) => {
              error = new Error('foobar')
              error.code = grpc.status.NOT_FOUND

              stream.emit('error', error)
            }
          })

          call = client.getBidi(new Readable(), () => {})
          call.on('error', () => {})

          return agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.have.property('error.msg', 'foobar')
              expect(traces[0][0].meta['error.stack']).to.equal(error.stack)
              expect(traces[0][0].meta).to.have.property('error.type', 'Error')
              expect(traces[0][0].metrics).to.have.property('grpc.status.code', 5)
            })
        })

        it('should run the handler in the scope of the request', done => {
          buildClient({
            getUnary: (_, callback) => {
              try {
                callback()
                expect(tracer.scope().active()).to.not.be.null
                done()
              } catch (e) {
                done(e)
              }
            }
          }).then(client => client.getUnary({ first: 'foobar' }, () => {}), done)
        })

        it('should run the emitter in the scope of the caller', done => {
          let emitter = null

          buildClient({
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
              service: 'custom'
            },
            client: false
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

      describe('with metadata configuration', () => {
        before(() => {
          const config = {
            server: {
              metadata: values => values
            },
            client: false
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

        it('should not alter the request metadata', done => {
          buildClient({
            getUnary: (call, callback) => {
              callback(null, {})

              try {
                expect(call.metadata.getMap()).to.have.property('foo', 'bar')
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
      })
    })
  })
})
