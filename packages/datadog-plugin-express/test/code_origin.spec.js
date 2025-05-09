'use strict'

const axios = require('axios')
const agent = require('../../dd-trace/test/plugins/agent')
const { getNextLineNumber } = require('../../dd-trace/test/plugins/helpers')

const host = 'localhost'

describe('Plugin', () => {
  let express
  let app
  let listener

  describe('express', () => {
    withVersions('express', 'express', version => {
      afterEach(() => {
        listener && listener.close()
      })

      describe('with tracer config codeOriginForSpans.enabled: true', () => {
        before(() => {
          return agent.load(['express', 'http'], [{}, { client: false }], {
            codeOriginForSpans: { enabled: true }
          })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          express = require(`../../../versions/express@${version}`).get()
          app = express()
        })

        it('should add code_origin tag on entry spans when feature is enabled', done => {
          let routeRegisterLine

          // Wrap in a named function to have at least one frame with a function name
          function wrapperFunction () {
            routeRegisterLine = String(getNextLineNumber())
            app.get('/user', function userHandler (req, res) {
              res.end()
            })
          }

          const callWrapperLine = String(getNextLineNumber())
          wrapperFunction()

          listener = app.listen(0, host, () => {
            const port = listener.address().port

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

        it('should point to where actual route handler is configured, not the router', function testCase (done) {
          const router = express.Router()
          const routeRegisterLine = String(getNextLineNumber())
          router.get('/user', function userHandler (req, res) {
            res.end()
          })

          app.use('/v1', router)

          listener = app.listen(0, host, () => {
            const port = listener.address().port

            agent
              .use(traces => {
                const spans = traces[0]
                const tags = spans[0].meta

                expect(tags).to.have.property('_dd.code_origin.type', 'entry')

                expect(tags).to.have.property('_dd.code_origin.frames.0.file', __filename)
                expect(tags).to.have.property('_dd.code_origin.frames.0.line', routeRegisterLine)
                expect(tags).to.have.property('_dd.code_origin.frames.0.column').to.match(/^\d+$/)
                expect(tags).to.have.property('_dd.code_origin.frames.0.type', 'Context')
                expect(tags).to.have.property('_dd.code_origin.frames.0.method', 'testCase')

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
          app.get('/user', function userHandler (req, res) {
            res.end()
          })

          listener = app.listen(0, host, () => {
            const port = listener.address().port

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

        it('should point to middleware if middleware responds early', function testCase (done) {
          const middlewareRegisterLine = String(getNextLineNumber())
          app.use(function middleware (req, res, next) {
            res.end()
          })

          app.get('/user', function userHandler (req, res) {
            res.end()
          })

          listener = app.listen(0, host, () => {
            const port = listener.address().port

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
