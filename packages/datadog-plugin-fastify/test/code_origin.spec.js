'use strict'

const axios = require('axios')
const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
const { getNextLineNumber } = require('../../dd-trace/test/plugins/helpers')
const { NODE_MAJOR } = require('../../../version')

const host = 'localhost'

describe('Plugin', () => {
  let fastify
  let app

  describe('fastify', () => {
    withVersions('fastify', 'fastify', (version, _, specificVersion) => {
      if (NODE_MAJOR <= 18 && semver.satisfies(specificVersion, '>=5')) return

      afterEach(() => {
        app.close()
      })

      withExports('fastify', version, ['default', 'fastify'], '>=3', getExport => {
        describe('with tracer config codeOriginForSpans.enabled: true', () => {
          if (semver.satisfies(specificVersion, '<4')) return // TODO: Why doesn't it work on older versions?

          before(() => {
            return agent.load(
              ['fastify', 'find-my-way', 'http'],
              [{}, {}, { client: false }],
              { codeOriginForSpans: { enabled: true } }
            )
          })

          after(() => {
            return agent.close({ ritmReset: false })
          })

          beforeEach(() => {
            fastify = getExport()
            app = fastify()

            if (semver.intersects(version, '>=3')) {
              return app.register(require('../../../versions/middie').get())
            }
          })

          it('should add code_origin tag on entry spans when feature is enabled', done => {
            let routeRegisterLine

            // Wrap in a named function to have at least one frame with a function name
            function wrapperFunction () {
              routeRegisterLine = String(getNextLineNumber())
              app.get('/user', function userHandler (request, reply) {
                reply.send()
              })
            }

            const callWrapperLine = String(getNextLineNumber())
            wrapperFunction()

            app.listen(() => {
              const port = app.server.address().port

              agent
                .use(traces => {
                  const spans = traces[0]
                  const tags = spans[0].meta

                  expect(tags).to.have.property('_dd.code_origin.type', 'entry')

                  expect(tags).to.have.property('_dd.code_origin.frames.0.file', __filename)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.line', routeRegisterLine)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.column').to.match(/^\d+$/)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.method', 'wrapperFunction')
                  expect(tags).to.not.have.property('_dd.code_origin.frames.0.type')

                  expect(tags).to.have.property('_dd.code_origin.frames.1.file', __filename)
                  expect(tags).to.have.property('_dd.code_origin.frames.1.line', callWrapperLine)
                  expect(tags).to.have.property('_dd.code_origin.frames.1.column').to.match(/^\d+$/)
                  expect(tags).to.not.have.property('_dd.code_origin.frames.1.method')
                  expect(tags).to.have.property('_dd.code_origin.frames.1.type', 'Context')

                  expect(tags).to.not.have.property('_dd.code_origin.frames.2.file')
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })

          it('should point to where actual route handler is configured, not the prefix', done => {
            let routeRegisterLine

            app.register(function v1Handler (app, opts, done) {
              routeRegisterLine = String(getNextLineNumber())
              app.get('/user', function userHandler (request, reply) {
                reply.send()
              })
              done()
            }, { prefix: '/v1' })

            app.listen(() => {
              const port = app.server.address().port

              agent
                .use(traces => {
                  const spans = traces[0]
                  const tags = spans[0].meta

                  expect(tags).to.have.property('_dd.code_origin.type', 'entry')

                  expect(tags).to.have.property('_dd.code_origin.frames.0.file', __filename)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.line', routeRegisterLine)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.column').to.match(/^\d+$/)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.method', 'v1Handler')
                  expect(tags).to.not.have.property('_dd.code_origin.frames.0.type')

                  expect(tags).to.not.have.property('_dd.code_origin.frames.1.file')
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/v1/user`)
                .catch(done)
            })
          })

          it('should point to route handler even if passed through a middleware', function testCase (done) {
            app.use(function middleware (req, res, next) {
              next()
            })

            const routeRegisterLine = String(getNextLineNumber())
            app.get('/user', function userHandler (request, reply) {
              reply.send()
            })

            app.listen({ host, port: 0 }, () => {
              const port = app.server.address().port

              agent
                .use(traces => {
                  const spans = traces[0]
                  const tags = spans[0].meta

                  expect(tags).to.have.property('_dd.code_origin.type', 'entry')

                  expect(tags).to.have.property('_dd.code_origin.frames.0.file', __filename)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.line', routeRegisterLine)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.column').to.match(/^\d+$/)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.method', 'testCase')
                  expect(tags).to.have.property('_dd.code_origin.frames.0.type', 'Context')

                  expect(tags).to.not.have.property('_dd.code_origin.frames.1.file')
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })

          // TODO: In Fastify, the route is resolved before the middleware is called, so we actually can get the line
          // number of where the route handler is defined. However, this might not be the right choice and it might be
          // better to point to the middleware.
          it.skip('should point to middleware if middleware responds early', function testCase (done) {
            const middlewareRegisterLine = String(getNextLineNumber())
            app.use(function middleware (req, res, next) {
              res.end()
            })

            app.get('/user', function userHandler (request, reply) {
              reply.send()
            })

            app.listen({ host, port: 0 }, () => {
              const port = app.server.address().port

              agent
                .use(traces => {
                  const spans = traces[0]
                  const tags = spans[0].meta

                  expect(tags).to.have.property('_dd.code_origin.type', 'entry')

                  expect(tags).to.have.property('_dd.code_origin.frames.0.file', __filename)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.line', middlewareRegisterLine)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.column').to.match(/^\d+$/)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.method', 'testCase')
                  expect(tags).to.have.property('_dd.code_origin.frames.0.type', 'Context')

                  expect(tags).to.not.have.property('_dd.code_origin.frames.1.file')
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })
        })
      })
    })
  })
})
