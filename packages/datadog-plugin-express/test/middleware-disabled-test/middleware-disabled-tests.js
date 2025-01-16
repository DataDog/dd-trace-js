'use strict'

const axios = require('axios')
const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../../../dd-trace/src/constants')
const agent = require('../../../dd-trace/test/plugins/agent')

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

module.exports = function middlewareDisabledTest (description, pluginConfig, tracerConfig) {
  describe('express middleware spans disabled tests', () => {
    let tracer
    let express
    let appListener
    withVersions('express', 'express', version => {
      beforeEach(() => {
        tracer = require('../../../dd-trace')
      })

      afterEach(() => {
        appListener && appListener.close()
        appListener = null
      })

      describe(`with configuration for middleware disabled via ${description} config`, () => {
        before(() => {
          return agent.load(['express', 'http'], pluginConfig, tracerConfig)
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          express = require(`../../../../versions/express@${version}`).get()
        })

        it('should not activate a scope per middleware', done => {
          const app = express()

          let span

          app.use((req, res, next) => {
            span = tracer.scope().active()
            next()
          })

          app.get('/user', (req, res) => {
            res.status(200).send()
            try {
              expect(tracer.scope().active()).to.equal(span).and.to.not.be.null
              done()
            } catch (e) {
              done(e)
            }
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            axios.get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should not do automatic instrumentation on middleware', done => {
          const app = express()

          app.use((req, res, next) => {
            next()
          })

          app.get('/user', (req, res, next) => {
            res.status(200).send()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /user')
                expect(traces.length).to.equal(1)
              })
              .then(done)
              .catch(done)

            axios.get(`http://localhost:${port}/user`)
              .catch(done)
          })
        })

        it('should handle error status codes', done => {
          const app = express()

          app.use((req, res, next) => {
            next()
          })

          app.get('/user', (req, res) => {
            res.status(500).send()
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent.use(traces => {
              const spans = sort(traces[0])

              expect(spans[0]).to.have.property('error', 1)
              expect(spans[0]).to.have.property('resource', 'GET /user')
              expect(spans[0].meta).to.have.property('http.status_code', '500')
              expect(spans[0].meta).to.have.property('component', 'express')

              done()
            })

            axios
              .get(`http://localhost:${port}/user`, {
                validateStatus: status => status === 500
              })
              .catch(done)
          })
        })

        it('should only handle errors for configured status codes', done => {
          const app = express()

          app.use((req, res, next) => {
            next()
          })

          app.get('/user', (req, res) => {
            res.statusCode = 400
            throw new Error('boom')
          })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('error', 0)
                expect(spans[0]).to.have.property('resource', 'GET /user')
                expect(spans[0].meta).to.have.property('http.status_code', '400')
                expect(spans[0].meta).to.have.property('component', 'express')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user`, {
                validateStatus: status => status === 400
              })
              .catch(done)
          })
        })

        it('should handle middleware errors', done => {
          const app = express()
          const error = new Error('boom')

          app.use((req, res) => { throw error })
          // eslint-disable-next-line n/handle-callback-err
          app.use((error, req, res, next) => res.status(500).send())

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('error', 1)
                expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
                expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
                expect(spans[0].meta).to.have.property('component', 'express')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user`, {
                validateStatus: status => status === 500
              })
              .catch(done)
          })
        })

        it('should handle request errors', done => {
          const app = express()
          const error = new Error('boom')

          app.use(() => { throw error })

          appListener = app.listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('error', 1)
                expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
                expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
                expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
                expect(spans[0].meta).to.have.property('http.status_code', '500')
                expect(spans[0].meta).to.have.property('component', 'express')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/user`, {
                validateStatus: status => status === 500
              })
              .catch(done)
            })
          })
        })
      }
    )
  })
}
